/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { showNotification } from "@api/Notifications";
import { sendMessage } from "@utils/discord";
import { useAwaiter } from "@utils/react";
import { IconComponent } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { useRef, UserStore, useState } from "@webpack/common";
import type { MouseEvent as ReactMouseEvent } from "react";

import { packPublicKeyShare } from "../crypto";
import { getContacts, getOwnKey } from "../keyStore";
import { openPgpSettings } from "../openSettings";
import { enabledChannels, setChannelEnabled } from "../state";

const HOLD_TO_SETTINGS_MS = 500;

export const LockIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 -960 960 960" height={height} width={width} className={className}>
        <path
            fill="currentColor"
            d="M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm240-200q33 0 56.5-23.5T560-360q0-33-23.5-56.5T480-440q-33 0-56.5 23.5T400-360q0 33 23.5 56.5T480-280ZM360-640h240v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80Z"
        />
    </svg>
);

function notify(body: string, onClick?: () => void) {
    showNotification({ title: "PGP Encryption", body, onClick });
}

async function canEnable(channel: Channel): Promise<boolean> {
    const ownKey = await getOwnKey();
    if (!ownKey) {
        notify("You don't have a PGP keypair yet. Click here to open the plugin settings and generate one.", openPgpSettings);
        return false;
    }

    const contacts = await getContacts();
    const missing = channel.recipients.filter(id => !contacts[id]);
    if (missing.length > 0) {
        const names = missing.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
        notify(`Missing PGP keys for: ${names}. Right-click the lock to share yours and ask them to do the same.`);
        return false;
    }

    return true;
}

async function shareOwnKey(channelId: string) {
    const ownKey = await getOwnKey();
    if (!ownKey) {
        notify("You don't have a PGP keypair yet. Click here to open the plugin settings and generate one.", openPgpSettings);
        return;
    }

    sendMessage(channelId, { content: await packPublicKeyShare(ownKey.publicKey) });
}

export const PgpChatBarIcon: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    const [nonce, setNonce] = useState(0);
    const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const held = useRef(false);

    const enabled = channel != null && enabledChannels.has(channel.id);

    // re-checked whenever the DM is opened, so a deleted keypair or a missing
    // recipient key shows up instead of a false green
    const [problem] = useAwaiter(async () => {
        if (!enabled || !channel) return null;

        const ownKey = await getOwnKey();
        if (!ownKey) return "you have no keypair";

        const contacts = await getContacts();
        const missing = channel.recipients.filter(id => !contacts[id]);
        if (missing.length > 0) {
            const names = missing.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
            return `missing keys for ${names}`;
        }

        return null;
    }, { fallbackValue: null, deps: [channel?.id, enabled, nonce] });

    if (!isMainChat || !channel?.isPrivate()) return null;

    async function toggle() {
        if (!enabled && !await canEnable(channel)) return;
        await setChannelEnabled(channel.id, !enabled);
        setNonce(n => n + 1);
    }

    function startHold(e: ReactMouseEvent<HTMLDivElement>) {
        if (e.button !== 0 && e.button !== 2) return;
        held.current = false;
        holdTimer.current = setTimeout(() => {
            held.current = true;
            openPgpSettings();
        }, HOLD_TO_SETTINGS_MS);
    }

    function cancelHold() {
        if (holdTimer.current !== null) {
            clearTimeout(holdTimer.current);
            holdTimer.current = null;
        }
    }

    /** True if the released press already opened settings and should not also toggle/share */
    function consumedHold() {
        cancelHold();
        if (held.current) {
            held.current = false;
            return true;
        }
        return false;
    }

    return (
        <ChatBarButton
            tooltip={(enabled
                ? problem
                    ? `PGP encryption is ON but BROKEN: ${problem} · click to disable`
                    : "PGP encryption is ON · click to disable"
                : "PGP encryption is OFF · click to enable")
                + " · right-click to share your key · hold to open settings"}
            onClick={() => {
                if (consumedHold()) return;
                void toggle();
            }}
            onContextMenu={e => {
                e.preventDefault();
                if (consumedHold()) return;
                void shareOwnKey(channel.id);
            }}
            buttonProps={{
                onMouseDown: startHold,
                onMouseUp: cancelHold,
                onPointerLeave: cancelHold
            }}
        >
            <LockIcon className={enabled ? (problem ? "vc-pgp-lock-broken" : "vc-pgp-lock-enabled") : "vc-pgp-lock"} />
        </ChatBarButton>
    );
};
