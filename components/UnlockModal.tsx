/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, TextInput, useState } from "@webpack/common";
import type { PrivateKey } from "openpgp";
import type { KeyboardEvent } from "react";

import { getSessionKey, unlockWithPassphrase } from "../keyStore";
import { rememberPassphrase } from "../rememberedPassphrase";

function UnlockModal({ props, resolve }: { props: RenderModalProps; resolve: (key: PrivateKey | null) => void; }) {
    const [passphrase, setPassphrase] = useState("");
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function tryUnlock() {
        if (!passphrase || busy) return;

        setBusy(true);
        setError(null);
        try {
            const key = await unlockWithPassphrase(passphrase);
            if (remember) await rememberPassphrase(passphrase);
            resolve(key);
            props.onClose();
        } catch {
            setError("Incorrect passphrase");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            {...props}
            title="Unlock PGP Key"
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: () => {
                        resolve(null);
                        props.onClose();
                    }
                },
                {
                    text: busy ? "Unlocking..." : "Unlock",
                    variant: "primary",
                    onClick: tryUnlock
                }
            ]}
        >
            <Paragraph>Enter your passphrase to unlock your PGP private key for this session.</Paragraph>
            <div className={Margins.top8}>
                <TextInput
                    type="password"
                    autoFocus
                    value={passphrase}
                    onChange={setPassphrase}
                    error={error ?? undefined}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") tryUnlock();
                    }}
                />
            </div>
            <div className={Margins.top16}>
                <FormSwitch
                    title="Remember passphrase on this device"
                    description="Auto-unlocks on startup. Stored encrypted with a device-bound key, about as protected as your Discord login itself. Leave off on shared computers. Warning: with this on you may not type your passphrase for months, so keep it written down somewhere safe, not just memorized."
                    value={remember}
                    onChange={setRemember}
                    hideBorder
                />
            </div>
        </Modal>
    );
}

/**
 * Returns the decrypted private key, prompting for the passphrase if it isn't
 * unlocked yet. Resolves null if the user dismisses the prompt.
 */
export function ensureUnlocked(): Promise<PrivateKey | null> {
    const existing = getSessionKey();
    if (existing) return Promise.resolve(existing);

    return new Promise(res => {
        let resolved = false;
        const resolve = (key: PrivateKey | null) => {
            if (resolved) return;
            resolved = true;
            res(key);
        };

        openModal(
            props => <UnlockModal props={props} resolve={resolve} />,
            { onCloseCallback: () => resolve(null) }
        );
    });
}
