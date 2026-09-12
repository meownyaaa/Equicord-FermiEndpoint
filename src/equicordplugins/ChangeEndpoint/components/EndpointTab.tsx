/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Card } from "@components/Card";
import { DoubleCheckmarkIcon, PencilIcon, PlusIcon, TrashIcon, WebsiteIcon } from "@components/Icons";
import { HeadingPrimary, HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings";
import { PREDEFINED_SERVERS } from "@equicordplugins/ChangeEndpoint/servers";
import type { CustomServer } from "@equicordplugins/ChangeEndpoint/servers";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { Alerts, Button, React, TextInput, UserStore, useState } from "@webpack/common";

import { settings } from "../settings";

const SETTING_KEYS = ["backend", "customServers", "accountBackends"] as Array<"backend" | "customServers" | "accountBackends">;

function makeServerId(): string {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function serverName(id: string): string {
    const predefined = PREDEFINED_SERVERS.find(s => s.id === id);
    if (predefined) return predefined.name;
    const custom = settings.store.customServers.find(s => s.id === id);
    return custom?.name ?? "Unknown Server";
}

function confirmRestart() {
    Alerts.show({
        title: "Restart Required",
        body: <p style={{ textAlign: "center" }}>ChangeEndpoint needs a restart to connect to the new server.</p>,
        confirmText: "Restart Now",
        cancelText: "Later",
        onConfirm: () => location.reload()
    });
}

function activeServerLabel(): { name: string; host: string; } {
    const { backend, customServers } = settings.store;

    const predefined = PREDEFINED_SERVERS.find(s => s.id === backend);
    if (predefined) return { name: predefined.name, host: predefined.host };

    const custom = customServers.find(s => s.id === backend);
    if (custom) return { name: custom.name, host: custom.host || custom.apiEndpoint || "not set" };

    return { name: "None", host: "not set" };
}

function CustomServerForm({ existing, onDone }: { existing?: CustomServer; onDone(): void; }) {
    const [name, setName] = useState(existing?.name ?? "");
    const [type, setType] = useState<"simple" | "advanced">(existing?.type ?? "simple");
    const [host, setHost] = useState(existing?.host ?? "");
    const [apiEndpoint, setApiEndpoint] = useState(existing?.apiEndpoint ?? "");
    const [cdnHost, setCdnHost] = useState(existing?.cdnHost ?? "");
    const [gatewayEndpoint, setGatewayEndpoint] = useState(existing?.gatewayEndpoint ?? "");
    const [mediaProxyEndpoint, setMediaProxyEndpoint] = useState(existing?.mediaProxyEndpoint ?? "");

    const canSave = !!name.trim() && (type === "simple"
        ? !!host.trim()
        : !!(apiEndpoint.trim() && cdnHost.trim() && gatewayEndpoint.trim() && mediaProxyEndpoint.trim()));

    const save = () => {
        const id = existing?.id ?? makeServerId();
        const entry: CustomServer = {
            id,
            name: name.trim(),
            type,
            host: host.trim() || undefined,
            apiEndpoint: apiEndpoint.trim() || undefined,
            cdnHost: cdnHost.trim() || undefined,
            gatewayEndpoint: gatewayEndpoint.trim() || undefined,
            mediaProxyEndpoint: mediaProxyEndpoint.trim() || undefined
        };

        const wasActive = settings.store.backend === existing?.id;
        settings.store.customServers = existing
            ? settings.store.customServers.map(s => (s.id === existing.id ? entry : s))
            : [...settings.store.customServers, entry];

        onDone();

        if (wasActive || !existing) {
            settings.store.backend = id;
            confirmRestart();
        }
    };

    return (
        <Card className={classes(Margins.top8, "vc-endpoint-form")}>
            <TextInput value={name} placeholder={"Display name (e.g. \"My Instance\")"} onChange={setName} />

            <div className={classes(Margins.top8, "vc-endpoint-type-toggle")}>
                <Button size={Button.Sizes.SMALL} look={Button.Looks.FILLED} color={type === "simple" ? Button.Colors.BRAND : Button.Colors.TRANSPARENT} onClick={() => setType("simple")}>Simplified</Button>
                <Button size={Button.Sizes.SMALL} look={Button.Looks.FILLED} color={type === "advanced" ? Button.Colors.BRAND : Button.Colors.TRANSPARENT} onClick={() => setType("advanced")}>Advanced</Button>
            </div>

            {type === "simple" ? (
                <>
                    <Paragraph className={Margins.top8}>Just the bare host, no scheme, no trailing slash (e.g. "rory.server.spacebar.chat"). Assumes the instance follows the standard api./cdn./gateway. convention.</Paragraph>
                    <TextInput value={host} placeholder="rory.server.spacebar.chat" onChange={setHost} />
                </>
            ) : (
                <>
                    <Paragraph className={Margins.top8}>Each endpoint separately, for instances that don't follow the standard convention. Values come from https://&lt;host&gt;/api/policies/instance/domains.</Paragraph>
                    <TextInput className={Margins.top8} value={apiEndpoint} placeholder="API endpoint" onChange={setApiEndpoint} />
                    <TextInput className={Margins.top8} value={cdnHost} placeholder="CDN host" onChange={setCdnHost} />
                    <TextInput className={Margins.top8} value={gatewayEndpoint} placeholder="Gateway endpoint" onChange={setGatewayEndpoint} />
                    <TextInput className={Margins.top8} value={mediaProxyEndpoint} placeholder="Media proxy endpoint" onChange={setMediaProxyEndpoint} />
                </>
            )}

            <div className={classes(Margins.top16, "vc-endpoint-form-actions")}>
                <Button size={Button.Sizes.SMALL} disabled={!canSave} onClick={save}>{existing ? "Save Changes" : "Add Server"}</Button>
                <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={onDone}>Cancel</Button>
            </div>
        </Card>
    );
}

function AccountLinkRow() {
    settings.use(["accountBackends", "backend"]);
    const currentUser = UserStore.getCurrentUser();
    const { accountBackends, backend } = settings.store;

    if (!currentUser) {
        return <Paragraph size="sm" className="vc-endpoint-muted">No account loaded yet.</Paragraph>;
    }

    const linkedBackend = accountBackends[currentUser.id];
    const links = Object.entries(accountBackends);

    const linkCurrent = () => {
        settings.store.accountBackends = { ...accountBackends, [currentUser.id]: backend };
    };

    const unlinkCurrent = () => {
        const next = { ...accountBackends };
        delete next[currentUser.id];
        settings.store.accountBackends = next;
    };

    return (
        <>
            <Card className="vc-endpoint-server-card">
                <div>
                    <Paragraph weight="bold">{currentUser.username}</Paragraph>
                    <Paragraph size="sm" className="vc-endpoint-muted">
                        {linkedBackend
                            ? `Linked to ${serverName(linkedBackend)}${linkedBackend !== backend ? " (different from what's selected above)" : ""}`
                            : "Not linked to any server"}
                    </Paragraph>
                </div>
                <Button size={Button.Sizes.SMALL} look={Button.Looks.FILLED} color={Button.Colors.TRANSPARENT} onClick={linkedBackend ? unlinkCurrent : linkCurrent}>
                    {linkedBackend ? "Unlink" : `Link to ${serverName(backend)}`}
                </Button>
            </Card>

            {links.length > 0 && (
                <Paragraph size="sm" className={classes(Margins.top8, "vc-endpoint-muted")}>
                    {links.length} account{links.length === 1 ? "" : "s"} linked in total. Only linked accounts
                    trigger an automatic server switch; everyone else keeps whatever server is currently selected.
                </Paragraph>
            )}
        </>
    );
}

function EndpointTab() {
    settings.use(SETTING_KEYS);
    const [addingCustom, setAddingCustom] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);

    const { backend, customServers } = settings.store;
    const active = activeServerLabel();
    const editingServer = editingId ? customServers.find(s => s.id === editingId) : undefined;

    const selectServer = (id: string) => {
        if (settings.store.backend === id) return;
        settings.store.backend = id;
        confirmRestart();
    };

    const removeCustomServer = (id: string) => {
        Alerts.show({
            title: "Remove Server?",
            body: `This removes "${serverName(id)}" from your server list.`,
            confirmText: "Remove",
            confirmColor: Button.Colors.RED,
            cancelText: "Cancel",
            onConfirm: () => {
                settings.store.customServers = settings.store.customServers.filter(s => s.id !== id);
                if (settings.store.backend === id) {
                    settings.store.backend = PREDEFINED_SERVERS[0].id;
                    confirmRestart();
                }
            }
        });
    };

    return (
        <div className="vc-endpoint-tab">
            <Card className="vc-endpoint-status-card">
                <div className="vc-endpoint-status-left">
                    <WebsiteIcon height={20} width={20} />
                    <div>
                        <Paragraph weight="bold">Connected to {active.name}</Paragraph>
                        <Paragraph size="sm" className="vc-endpoint-muted">{active.host}</Paragraph>
                    </div>
                </div>
                <div className="vc-endpoint-status-right">
                    <DoubleCheckmarkIcon height={16} width={16} />
                    Connected
                </div>
            </Card>

            <HeadingPrimary className={Margins.top20}>Servers</HeadingPrimary>
            <Paragraph className={classes(Margins.bottom8, "vc-endpoint-muted")}>Pick a Spacebar backend to connect to. Changing this requires a restart.</Paragraph>

            <div className="vc-endpoint-server-list">
                {PREDEFINED_SERVERS.map(server => (
                    <Card
                        key={server.id}
                        className={classes("vc-endpoint-server-card", backend === server.id && "vc-endpoint-server-card-active")}
                        onClick={() => selectServer(server.id)}
                    >
                        <div>
                            <Paragraph weight="bold">{server.name}</Paragraph>
                            <Paragraph size="sm" className="vc-endpoint-muted">{server.host}</Paragraph>
                        </div>
                        {backend === server.id && <DoubleCheckmarkIcon height={16} width={16} />}
                    </Card>
                ))}

                {customServers.map(server => (
                    <Card
                        key={server.id}
                        className={classes("vc-endpoint-server-card", backend === server.id && "vc-endpoint-server-card-active")}
                        onClick={() => selectServer(server.id)}
                    >
                        <div>
                            <Paragraph weight="bold">{server.name}</Paragraph>
                            <Paragraph size="sm" className="vc-endpoint-muted">{server.host || server.apiEndpoint}</Paragraph>
                        </div>
                        <div className="vc-endpoint-server-card-actions">
                            {backend === server.id && <DoubleCheckmarkIcon height={16} width={16} />}
                            <button
                                className="vc-endpoint-icon-button"
                                onClick={e => { e.stopPropagation(); setAddingCustom(false); setEditingId(server.id); }}
                                title="Edit"
                            >
                                <PencilIcon height={14} width={14} />
                            </button>
                            <button
                                className="vc-endpoint-icon-button vc-endpoint-icon-button-danger"
                                onClick={e => { e.stopPropagation(); removeCustomServer(server.id); }}
                                title="Remove"
                            >
                                <TrashIcon height={14} width={14} />
                            </button>
                        </div>
                    </Card>
                ))}
            </div>

            {editingServer ? (
                <CustomServerForm existing={editingServer} onDone={() => setEditingId(null)} />
            ) : addingCustom ? (
                <CustomServerForm onDone={() => setAddingCustom(false)} />
            ) : (
                <div className={classes(Margins.top8, "vc-endpoint-form-actions")}>
                    <Button size={Button.Sizes.SMALL} look={Button.Looks.FILLED} color={Button.Colors.TRANSPARENT} onClick={() => setAddingCustom(true)}>
                        <PlusIcon height={14} width={14} /> Add Custom Server
                    </Button>
                </div>
            )}

            <HeadingPrimary className={Margins.top24}>Accounts</HeadingPrimary>
            <Paragraph className={classes(Margins.bottom8, "vc-endpoint-muted")}>
                Link the account you're currently on to the server selected above. Switching to a linked
                account from Discord's own account switcher will switch to its server too (a reload happens
                once the switch finishes).
            </Paragraph>
            <AccountLinkRow />

            <HeadingTertiary className={Margins.top24}>About</HeadingTertiary>
            <Paragraph size="sm" className="vc-endpoint-muted">Spacebar is the default instance. Add a custom server to connect to a different one instead.</Paragraph>
        </div>
    );
}

function ChangeEndpointTab() {
    return (
        <SettingsTab>
            <EndpointTab />
        </SettingsTab>
    );
}

export default wrapTab(ChangeEndpointTab, "ChangeEndpoint");
