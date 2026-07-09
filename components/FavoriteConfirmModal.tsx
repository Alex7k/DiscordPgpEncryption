/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useState } from "@webpack/common";

import { settings } from "../settings";

function FavoriteConfirmModal({ props, host, resolve }: {
    props: RenderModalProps;
    host: string;
    resolve: (confirmed: boolean, neverAskAgain: boolean) => void;
}) {
    const [never, setNever] = useState(false);

    return (
        <Modal
            {...props}
            title="Save to your Discord favorites?"
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: () => {
                        resolve(false, false);
                        props.onClose();
                    }
                },
                {
                    text: "Favorite",
                    variant: "primary",
                    onClick: () => {
                        resolve(true, never);
                        props.onClose();
                    }
                }
            ]}
        >
            <Paragraph>
                Favoriting saves this GIF's link to your Discord account settings — the
                same as starring any GIF on Discord. That part is not end-to-end
                encrypted: Discord can see you favorited this GIF, but learns nothing
                about this conversation or who sent it.
            </Paragraph>
            <Paragraph className={Margins.top8}>
                The GIF comes from <strong>{host}</strong>. Your GIF picker will load
                its preview from that site whenever you browse your favorites, which
                reveals your IP address to it. You won't be asked again for this site.
            </Paragraph>
            <div className={Margins.top16}>
                <FormSwitch
                    title="Don't ask again for any site"
                    description="Can be re-enabled in the plugin settings"
                    value={never}
                    onChange={setNever}
                    hideBorder
                />
            </div>
        </Modal>
    );
}

/**
 * Gate before adding a favorite: explains, once per host, that favoriting
 * steps outside e2ee. Resolves true when the user may proceed.
 */
export function confirmFavoriteGif(sourceUrl: string): Promise<boolean> {
    let host = "";
    try {
        host = new URL(sourceUrl).hostname;
    } catch { }

    const ackedHosts: string[] = settings.store.favoriteGifAckHosts ?? [];
    if (settings.store.skipFavoriteDialog || (host && ackedHosts.includes(host))) {
        return Promise.resolve(true);
    }

    return new Promise(res => {
        let resolved = false;
        const resolve = (confirmed: boolean, neverAskAgain: boolean) => {
            if (resolved) return;
            resolved = true;
            if (confirmed) {
                if (neverAskAgain) settings.store.skipFavoriteDialog = true;
                if (host && !ackedHosts.includes(host)) {
                    // reassigned wholesale so the settings proxy reliably persists it
                    settings.store.favoriteGifAckHosts = [...ackedHosts, host];
                }
            }
            res(confirmed);
        };

        openModal(
            props => <FavoriteConfirmModal props={props} host={host || "an unknown site"} resolve={resolve} />,
            { onCloseCallback: () => resolve(false, false) }
        );
    });
}
