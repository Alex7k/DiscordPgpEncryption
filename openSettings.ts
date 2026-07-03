/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { openPluginModal } from "@components/settings";

export const openPgpSettings = () => openPluginModal(plugins.PgpEncrypt);
