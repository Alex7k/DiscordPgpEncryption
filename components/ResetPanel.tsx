/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Alerts, showToast } from "@webpack/common";

import { clearContacts, deleteOwnKey } from "../keyStore";
import { forgetPassphrase } from "../rememberedPassphrase";
import { clearEnabledChannels, clearMessageState } from "../state";

/**
 * The destructive reset, registered as the last plugin setting so it sits at
 * the very bottom of the page. The keypair card and contacts list above
 * refresh through the key store's change listeners, not through props.
 */
export function ResetPanel() {
    function confirmReset() {
        Alerts.show({
            title: "Reset all plugin data?",
            body: "Deletes your keypair, every trusted contact key, the saved passphrase, and all per-channel "
                + "encryption toggles on this device. Unless you have a key backup, messages encrypted to this "
                + "key become permanently unreadable. This cannot be undone.",
            confirmText: "Reset everything",
            cancelText: "Cancel",
            onConfirm: async () => {
                await forgetPassphrase();
                await deleteOwnKey();
                await clearContacts();
                await clearEnabledChannels();
                clearMessageState();
                showToast("All PgpEncrypt data wiped. Restart Discord for a clean slate.");
            }
        });
    }

    return (
        <div className="vc-pgp-danger-zone">
            <Paragraph size="xs" style={{ color: "var(--text-muted)" }}>
                Wipes the keypair, trusted contacts, saved passphrase and per-channel toggles on this device.
            </Paragraph>
            <Button size="small" variant="dangerPrimary" onClick={confirmReset}>
                Reset Plugin Data
            </Button>
        </div>
    );
}
