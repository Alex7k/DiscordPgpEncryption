/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Modal, openModal, useState } from "@webpack/common";

import { formatFingerprint } from "../crypto";
import { OwnKeyRecord } from "../keyStore";

const mutedText = { color: "var(--text-muted)" } as const;

function BackupModal({ props, record }: { props: RenderModalProps; record: OwnKeyRecord; }) {
    const [copied, setCopied] = useState(false);

    async function copyBackup() {
        await copyWithToast(record.privateKey, "Backup copied! Now store it somewhere safe.");
        setCopied(true);
    }

    function confirmSkip() {
        Alerts.show({
            title: "Skip the backup?",
            body: "Without a backup, losing this device (or its browser data) means losing every message "
                + "ever encrypted to this key, permanently. There is no recovery. "
                + "You can still back up later from the plugin settings, but later tends to become never.",
            confirmText: "Skip anyway",
            cancelText: "Go back",
            onConfirm: () => props.onClose()
        });
    }

    return (
        <Modal
            {...props}
            title="Back up your key before anything else"
            actions={[
                copied
                    ? {
                        text: "Done",
                        variant: "primary" as const,
                        onClick: () => props.onClose()
                    }
                    : {
                        text: "Skip for now (risky)",
                        variant: "secondary" as const,
                        onClick: confirmSkip
                    },
                {
                    text: copied ? "Copy Again" : "Copy Backup to Clipboard",
                    variant: "primary",
                    onClick: copyBackup
                }
            ]}
        >
            <Paragraph>
                Your keypair is ready. Before you send a single message, save a backup of your private key.
                If this device or its browser data is ever lost, the backup is the only way to keep reading
                your encrypted messages. There is no account recovery, no reset email, nothing.
            </Paragraph>
            <Paragraph className={Margins.top8}>
                Click the button below to copy the backup, then paste it somewhere safe such as a password
                manager. The backup stays locked with your passphrase, so it is useless to anyone who has
                the text but not the passphrase. You need both to restore or to set up another device.
            </Paragraph>
            <Paragraph className={Margins.top8}>
                Step two: save your passphrase in your password manager as well, as a separate entry.
                The backup cannot be unlocked without it, and memory alone is not a backup. If you ever
                enable "remember passphrase on this device", you may not type it for months and forgetting
                it becomes easy.
            </Paragraph>
            <Paragraph className={Margins.top8} size="xs" style={mutedText}>
                Key fingerprint: {formatFingerprint(record.fingerprint)}
            </Paragraph>
            {copied && (
                <Paragraph className={Margins.top8} size="xs" style={mutedText}>
                    Copied! Paste it into your password manager now, before closing this window.
                </Paragraph>
            )}
        </Modal>
    );
}

export function openBackupModal(record: OwnKeyRecord) {
    openModal(props => <BackupModal props={props} record={record} />);
}
