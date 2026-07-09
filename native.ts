/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const MAX_GIF_BYTES = 100 * 1024 * 1024;

/** media file extensions the renderer-side picker interception sends here */
const MEDIA_EXT_RE = /\.(gif|mp4|webm|webp|png|jpe?g)$/i;

/**
 * Downloads GIF media in the main process, where Discord's renderer CSP does
 * not apply. IP-safety: this only ever runs on the SENDER's machine for a gif
 * the sender clicked in their own picker, whose preview the picker already
 * fetched from the same host — so any https media URL is fair game (favorites
 * can live anywhere, not just Tenor/Giphy). The recipient never fetches.
 * It is still not a generic proxy: https + media extension + size cap only.
 * Errors are returned as values so the renderer can fall back gracefully.
 */
export async function fetchGifMedia(_: IpcMainInvokeEvent, url: string): Promise<{ ok: true; data: Uint8Array; } | { ok: false; error: string; }> {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !MEDIA_EXT_RE.test(parsed.pathname))
            return { ok: false, error: `refusing to fetch non-media url from ${parsed.hostname}` };

        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_GIF_BYTES) return { ok: false, error: "media too large" };
        return { ok: true, data: new Uint8Array(buf) };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}
