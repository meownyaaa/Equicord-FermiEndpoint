/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { requireStyle, setStyleClassNames } from "@api/Styles";
import { filters, mapMangledCssClasses, waitFor } from "@webpack";

export function setStyleClassNamesFromModule(style: string, prefix: string, names: string[]) {
    const byClassNames = filters.byClassNames(...names);

    waitFor(m => {
        try {
            return byClassNames(m);
        } catch {
            return false;
        }
    }, m => {
        const mapped = mapMangledCssClasses(m, names);
        const classNames = { ...requireStyle(style).classNames };
        for (const name of names) classNames[`${prefix}_${name}`] = mapped[name];
        setStyleClassNames(style, classNames);
    }, { isIndirect: true });
}
