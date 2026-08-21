/**
 * Shared ecosystem attachments.
 *
 * Files live in Supabase Storage (`attachments` bucket). Postgres stores
 * file metadata (`attachments`) and per-app ownership (`attachment_links`).
 *
 * Capture, Flight, and River use separate records today, so transfers
 * relink the same attachment_id to the new owner — they never copy the
 * stored file.
 */
(function (root) {
  const BUCKET = "attachments";
  const OWNER = Object.freeze({
    draft: "draft",
    todoInbox: "todo_inbox",
    todoTask: "todo_task",
    journalEntry: "journal_entry",
  });

  const EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };

  function createId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const hex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}000000000000`.slice(
      0,
      32,
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  function cacheKey(ownerType, ownerId) {
    return `${ownerType}:${ownerId}`;
  }

  function extensionFor(file) {
    const mime = String(file?.type || "").toLowerCase();
    if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
    const name = typeof file?.name === "string" ? file.name : "";
    const dot = name.lastIndexOf(".");
    if (dot > 0 && dot < name.length - 1) {
      return name
        .slice(dot + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 8) || "bin";
    }
    return "bin";
  }

  function isImageMime(mime) {
    return String(mime || "").toLowerCase().startsWith("image/");
  }

  function isImageFile(file) {
    if (!file) return false;
    if (isImageMime(file.type)) return true;
    return /\.(png|jpe?g|gif|webp|heic|heif|avif|svg)$/i.test(file.name || "");
  }

  function uniqueFiles(files) {
    const seen = new Set();
    const out = [];
    for (const file of files) {
      if (!(file instanceof Blob)) continue;
      // Ignore lastModified: getAsFile() stamps "now", while DataTransfer.files
      // often uses 0, so the same screenshot would look like two files.
      const key = `${file.name || ""}:${file.size}:${file.type || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
    return out;
  }

  function preferRasterImages(files) {
    const rasters = files.filter((file) =>
      /^image\/(png|jpe?g|webp|gif|heic|heif|avif)$/i.test(file.type || ""),
    );
    if (rasters.length > 0) return rasters;
    return files.filter((file) => !/^image\/tiff$/i.test(file.type || ""));
  }

  function filesFromClipboard(clipboardData) {
    if (!clipboardData) return [];
    // Prefer .files. Walking items AND files lists the same macOS screenshot twice.
    let files = [];
    if (clipboardData.files && clipboardData.files.length > 0) {
      files = [...clipboardData.files];
    } else if (clipboardData.items) {
      for (const item of clipboardData.items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    return preferRasterImages(uniqueFiles(files));
  }

  function filesFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];
    const files = [];
    if (dataTransfer.files) {
      for (const file of dataTransfer.files) files.push(file);
    }
    if (files.length === 0 && dataTransfer.items) {
      for (const item of dataTransfer.items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    return uniqueFiles(preferRasterImages(files));
  }

  function normalizeRow(link) {
    const attachment = link?.attachment || link?.attachments || null;
    if (!link || !attachment || typeof attachment.id !== "string") return null;
    return {
      linkId: link.id,
      attachmentId: attachment.id,
      ownerType: link.owner_type,
      ownerId: String(link.owner_id),
      position: Number.isFinite(Number(link.position)) ? Number(link.position) : 0,
      storagePath: attachment.storage_path,
      mimeType: attachment.mime_type,
      byteSize: attachment.byte_size ?? null,
      originalFilename: attachment.original_filename || null,
      createdAt: attachment.created_at || link.created_at,
    };
  }

  const SELECT =
    "id, attachment_id, owner_type, owner_id, position, created_at, attachment:attachments(*)";

  function create(supabase) {
    /** @type {Map<string, ReturnType<typeof normalizeRow>[]>} */
    const cache = new Map();
    let lightboxEl = null;
    let lightboxItems = [];
    let lightboxIndex = 0;

    function publicUrl(storagePath) {
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
      return data?.publicUrl || "";
    }

    function getCached(ownerType, ownerId) {
      return cache.get(cacheKey(ownerType, ownerId)) || [];
    }

    function setCached(ownerType, ownerId, items) {
      const key = cacheKey(ownerType, ownerId);
      const next = [...(items || [])].sort((a, b) => a.position - b.position || String(a.createdAt).localeCompare(String(b.createdAt)));
      cache.set(key, next);
      return next;
    }

    function moveCache(fromType, fromId, toType, toId) {
      const items = getCached(fromType, fromId).map((item) => ({
        ...item,
        ownerType: toType,
        ownerId: String(toId),
      }));
      cache.delete(cacheKey(fromType, fromId));
      return setCached(toType, toId, items);
    }

    async function list(ownerType, ownerId) {
      const { data, error } = await supabase
        .from("attachment_links")
        .select(SELECT)
        .eq("owner_type", ownerType)
        .eq("owner_id", String(ownerId))
        .order("position", { ascending: true });
      if (error) throw error;
      const items = (data || []).map(normalizeRow).filter(Boolean);
      return setCached(ownerType, ownerId, items);
    }

    async function hydrate(ownerType, ownerIds) {
      const ids = [...new Set((ownerIds || []).map((id) => String(id)).filter(Boolean))];
      for (const id of ids) {
        if (!cache.has(cacheKey(ownerType, id))) setCached(ownerType, id, []);
      }
      const chunkSize = 200;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from("attachment_links")
          .select(SELECT)
          .eq("owner_type", ownerType)
          .in("owner_id", chunk)
          .order("position", { ascending: true });
        if (error) throw error;
        const grouped = new Map(chunk.map((id) => [id, []]));
        for (const row of data || []) {
          const item = normalizeRow(row);
          if (!item) continue;
          const listForOwner = grouped.get(item.ownerId) || [];
          listForOwner.push(item);
          grouped.set(item.ownerId, listForOwner);
        }
        for (const [id, items] of grouped) {
          setCached(ownerType, id, items);
        }
      }
    }

    async function nextPosition(ownerType, ownerId) {
      const existing = getCached(ownerType, ownerId);
      if (existing.length > 0) {
        return existing.reduce((max, item) => Math.max(max, item.position), -1) + 1;
      }
      const { data, error } = await supabase
        .from("attachment_links")
        .select("position")
        .eq("owner_type", ownerType)
        .eq("owner_id", String(ownerId))
        .order("position", { ascending: false })
        .limit(1);
      if (error) throw error;
      const top = Number(data?.[0]?.position);
      return Number.isFinite(top) ? top + 1 : 0;
    }

    async function upload(file, { ownerType, ownerId }) {
      if (!file) throw new Error("No file to attach.");
      const attachmentId = createId();
      const ext = extensionFor(file);
      const storagePath = `${attachmentId}.${ext}`;
      const mimeType = file.type || "application/octet-stream";

      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, file, {
        contentType: mimeType,
        upsert: false,
        cacheControl: "31536000",
      });
      if (uploadError) throw uploadError;

      const { error: metaError } = await supabase.from("attachments").insert({
        id: attachmentId,
        storage_path: storagePath,
        mime_type: mimeType,
        byte_size: Number.isFinite(file.size) ? file.size : null,
        original_filename: file.name || null,
      });
      if (metaError) {
        await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
        throw metaError;
      }

      const position = await nextPosition(ownerType, ownerId);
      const { data: link, error: linkError } = await supabase
        .from("attachment_links")
        .insert({
          attachment_id: attachmentId,
          owner_type: ownerType,
          owner_id: String(ownerId),
          position,
        })
        .select(SELECT)
        .single();
      if (linkError) {
        await supabase.from("attachments").delete().eq("id", attachmentId).catch(() => {});
        await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
        throw linkError;
      }

      const item = normalizeRow(link);
      const next = [...getCached(ownerType, ownerId), item];
      setCached(ownerType, ownerId, next);
      return item;
    }

    async function reown({ fromType, fromId, toType, toId }) {
      const fromKey = String(fromId);
      const toKey = String(toId);
      if (fromType === toType && fromKey === toKey) {
        return getCached(toType, toKey);
      }

      const { data: links, error } = await supabase
        .from("attachment_links")
        .select("id, attachment_id, position")
        .eq("owner_type", fromType)
        .eq("owner_id", fromKey)
        .order("position", { ascending: true });
      if (error) throw error;

      if (!links || links.length === 0) {
        await list(toType, toKey);
        return getCached(toType, toKey);
      }

      const { data: existingDest, error: destError } = await supabase
        .from("attachment_links")
        .select("attachment_id")
        .eq("owner_type", toType)
        .eq("owner_id", toKey);
      if (destError) throw destError;
      const destIds = new Set((existingDest || []).map((row) => row.attachment_id));

      for (const link of links) {
        if (destIds.has(link.attachment_id)) {
          const { error: delError } = await supabase
            .from("attachment_links")
            .delete()
            .eq("id", link.id);
          if (delError) throw delError;
          continue;
        }
        const { error: updateError } = await supabase
          .from("attachment_links")
          .update({ owner_type: toType, owner_id: toKey })
          .eq("id", link.id);
        if (updateError) throw updateError;
        destIds.add(link.attachment_id);
      }

      cache.delete(cacheKey(fromType, fromKey));
      return list(toType, toKey);
    }

    async function copyLinks({ fromType, fromId, toType, toId }) {
      const source = await list(fromType, fromId);
      if (source.length === 0) {
        setCached(toType, toId, []);
        return [];
      }

      const { data: existingDest, error: destError } = await supabase
        .from("attachment_links")
        .select("attachment_id")
        .eq("owner_type", toType)
        .eq("owner_id", String(toId));
      if (destError) throw destError;
      const destIds = new Set((existingDest || []).map((row) => row.attachment_id));

      const rows = source
        .filter((item) => !destIds.has(item.attachmentId))
        .map((item) => ({
          attachment_id: item.attachmentId,
          owner_type: toType,
          owner_id: String(toId),
          position: item.position,
        }));

      if (rows.length > 0) {
        const { error: insertError } = await supabase.from("attachment_links").insert(rows);
        if (insertError) throw insertError;
      }

      return list(toType, toId);
    }

    async function cleanupOrphans(attachmentIds) {
      const ids = [...new Set((attachmentIds || []).filter(Boolean))];
      for (const id of ids) {
        const { count, error: countError } = await supabase
          .from("attachment_links")
          .select("id", { count: "exact", head: true })
          .eq("attachment_id", id);
        if (countError) throw countError;
        if ((count || 0) > 0) continue;

        const { data: row, error: rowError } = await supabase
          .from("attachments")
          .select("id, storage_path")
          .eq("id", id)
          .maybeSingle();
        if (rowError) throw rowError;
        if (!row) continue;

        if (row.storage_path) {
          const { error: storageError } = await supabase.storage
            .from(BUCKET)
            .remove([row.storage_path]);
          if (storageError) console.warn("Attachment storage cleanup failed:", storageError);
        }
        const { error: deleteError } = await supabase.from("attachments").delete().eq("id", id);
        if (deleteError) throw deleteError;
      }
    }

    async function unlinkOwner({ ownerType, ownerId, cleanup = true }) {
      const { data: links, error } = await supabase
        .from("attachment_links")
        .select("id, attachment_id")
        .eq("owner_type", ownerType)
        .eq("owner_id", String(ownerId));
      if (error) throw error;

      if (links && links.length > 0) {
        const { error: deleteError } = await supabase
          .from("attachment_links")
          .delete()
          .eq("owner_type", ownerType)
          .eq("owner_id", String(ownerId));
        if (deleteError) throw deleteError;
      }

      cache.delete(cacheKey(ownerType, ownerId));
      if (cleanup) {
        await cleanupOrphans((links || []).map((row) => row.attachment_id));
      }
    }

    async function remove(linkId, { cleanup = true } = {}) {
      const { data: link, error } = await supabase
        .from("attachment_links")
        .select("id, attachment_id, owner_type, owner_id")
        .eq("id", linkId)
        .maybeSingle();
      if (error) throw error;
      if (!link) return;

      const { error: deleteError } = await supabase
        .from("attachment_links")
        .delete()
        .eq("id", linkId);
      if (deleteError) throw deleteError;

      const remaining = getCached(link.owner_type, link.owner_id).filter(
        (item) => item.linkId !== linkId,
      );
      setCached(link.owner_type, link.owner_id, remaining);
      if (cleanup) await cleanupOrphans([link.attachment_id]);
    }

    function ensureLightbox() {
      if (lightboxEl) return lightboxEl;
      const overlay = document.createElement("div");
      overlay.className = "eco-attach-lightbox";
      overlay.hidden = true;
      overlay.innerHTML = `
        <button type="button" class="eco-attach-lightbox-close" aria-label="Close">×</button>
        <button type="button" class="eco-attach-lightbox-prev" aria-label="Previous">‹</button>
        <img class="eco-attach-lightbox-image" alt="">
        <button type="button" class="eco-attach-lightbox-next" aria-label="Next">›</button>
      `;
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest(".eco-attach-lightbox-close")) {
          closeLightbox();
        }
      });
      overlay.querySelector(".eco-attach-lightbox-prev").addEventListener("click", (event) => {
        event.stopPropagation();
        showLightboxAt(lightboxIndex - 1);
      });
      overlay.querySelector(".eco-attach-lightbox-next").addEventListener("click", (event) => {
        event.stopPropagation();
        showLightboxAt(lightboxIndex + 1);
      });
      document.addEventListener("keydown", (event) => {
        if (overlay.hidden) return;
        if (event.key === "Escape") closeLightbox();
        if (event.key === "ArrowLeft") showLightboxAt(lightboxIndex - 1);
        if (event.key === "ArrowRight") showLightboxAt(lightboxIndex + 1);
      });
      document.body.appendChild(overlay);
      lightboxEl = overlay;
      return overlay;
    }

    function showLightboxAt(index) {
      const overlay = ensureLightbox();
      if (lightboxItems.length === 0) {
        closeLightbox();
        return;
      }
      lightboxIndex = (index + lightboxItems.length) % lightboxItems.length;
      const item = lightboxItems[lightboxIndex];
      const img = overlay.querySelector(".eco-attach-lightbox-image");
      img.src = publicUrl(item.storagePath);
      img.alt = item.originalFilename || "Attachment";
      overlay.querySelector(".eco-attach-lightbox-prev").hidden = lightboxItems.length < 2;
      overlay.querySelector(".eco-attach-lightbox-next").hidden = lightboxItems.length < 2;
      overlay.hidden = false;
    }

    function openLightbox(items, startIndex = 0) {
      lightboxItems = (items || []).filter((item) => isImageMime(item.mimeType));
      if (lightboxItems.length === 0) return;
      showLightboxAt(startIndex);
    }

    function closeLightbox() {
      if (!lightboxEl) return;
      lightboxEl.hidden = true;
      const img = lightboxEl.querySelector(".eco-attach-lightbox-image");
      if (img) img.src = "";
    }

    function createStrip(items, { removable = false, onRemove = null } = {}) {
      const strip = document.createElement("div");
      strip.className = "eco-attach-strip";
      if (!items || items.length === 0) {
        strip.hidden = true;
        return strip;
      }

      for (const item of items) {
        const figure = document.createElement("figure");
        figure.className = "eco-attach-item";
        figure.dataset.attachmentId = item.attachmentId;

        if (isImageMime(item.mimeType)) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "eco-attach-thumb-btn";
          button.title = item.originalFilename || "Open image";
          const img = document.createElement("img");
          img.className = "eco-attach-thumb";
          img.src = publicUrl(item.storagePath);
          img.alt = item.originalFilename || "Attachment";
          img.loading = "lazy";
          button.appendChild(img);
          button.addEventListener("click", () => {
            const images = items.filter((entry) => isImageMime(entry.mimeType));
            openLightbox(images, Math.max(0, images.findIndex((entry) => entry.attachmentId === item.attachmentId)));
          });
          figure.appendChild(button);
        } else {
          const link = document.createElement("a");
          link.className = "eco-attach-file";
          link.href = publicUrl(item.storagePath);
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = item.originalFilename || item.mimeType || "File";
          figure.appendChild(link);
        }

        if (removable) {
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "eco-attach-remove";
          removeBtn.setAttribute("aria-label", "Remove attachment");
          removeBtn.textContent = "×";
          removeBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof onRemove === "function") onRemove(item);
          });
          figure.appendChild(removeBtn);
        }

        strip.appendChild(figure);
      }

      return strip;
    }

    function renderStrip(container, items, options) {
      if (!container) return;
      const strip = createStrip(items, options);
      container.classList.add("eco-attach-strip");
      container.replaceChildren(...strip.childNodes);
      container.hidden = !items || items.length === 0;
    }

    return {
      OWNER,
      BUCKET,
      publicUrl,
      isImageFile,
      isImageMime,
      filesFromClipboard,
      filesFromDataTransfer,
      getCached,
      setCached,
      moveCache,
      list,
      hydrate,
      upload,
      reown,
      copyLinks,
      unlinkOwner,
      remove,
      cleanupOrphans,
      createStrip,
      renderStrip,
      openLightbox,
      closeLightbox,
    };
  }

  root.EcosystemAttachments = {
    OWNER,
    BUCKET,
    isImageFile,
    isImageMime,
    filesFromClipboard,
    filesFromDataTransfer,
    create,
  };
})(window);
