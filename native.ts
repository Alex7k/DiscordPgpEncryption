/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

/**
 * Only the GIF CDNs the sender's client already contacted while browsing the
 * picker, plus Discord's own media proxy (which the picker serves results
 * through). This must never grow into a generic fetch proxy: an arbitrary URL
 * fetched on someone's behalf is an IP-leak primitive.
 */
function isAllowedGifHost(hostname: string): boolean {
    return hostname === "tenor.com" || hostname.endsWith(".tenor.com")
        || hostname === "giphy.com" || hostname.endsWith(".giphy.com")
        || hostname === "media.discordapp.net" || /^images-ext-\d+\.discordapp\.net$/.test(hostname);
}

const MAX_GIF_BYTES = 100 * 1024 * 1024;

/**
 * Downloads GIF media in the main process, where Discord's renderer CSP does
 * not apply. Errors are returned as values so the renderer can fall back
 * gracefully instead of unwrapping an IPC exception.
 */
export async function fetchGifMedia(_: IpcMainInvokeEvent, url: string): Promise<{ ok: true; data: Uint8Array; } | { ok: false; error: string; }> {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !isAllowedGifHost(parsed.hostname))
            return { ok: false, error: `refusing to fetch from ${parsed.hostname}` };

        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        // a redirect could hop off the allowlist; check where we actually landed
        const finalHost = new URL(res.url).hostname;
        if (!isAllowedGifHost(finalHost)) return { ok: false, error: `redirected off-allowlist to ${finalHost}` };

        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_GIF_BYTES) return { ok: false, error: "media too large" };
        return { ok: true, data: new Uint8Array(buf) };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}
