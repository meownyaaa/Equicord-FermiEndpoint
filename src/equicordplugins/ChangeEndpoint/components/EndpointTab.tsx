/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button, TextButton } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { DoubleCheckmarkIcon, PencilIcon, PlusIcon, TrashIcon, WebsiteIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings";
import { type CustomServer,PREDEFINED_SERVERS } from "@equicordplugins/ChangeEndpoint/servers";
import { copyWithToast } from "@utils/discord";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { Alerts, React, RestAPI, TextInput, UserStore, useState } from "@webpack/common";

import ChangeEndpoint from "..";
import { discover } from "../discovery";
import { settings } from "../settings";
import { connectedBackend, hasEndpoints } from "../utils";

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

function activeServerLabel(): { name: string; host: string; } {
    const { backend, customServers } = settings.store;

    const predefined = PREDEFINED_SERVERS.find(s => s.id === backend);
    if (predefined) return { name: predefined.name, host: predefined.host };

    const custom = customServers.find(s => s.id === backend);
    if (custom) return { name: custom.name, host: (custom.type === "simple" ? custom.host : custom.apiEndpoint) || "not set" };

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
    const [discovering, setDiscovering] = useState(false);
    const [discoveryError, setDiscoveryError] = useState<string | null>(null);

    const findEndpoints = async () => {
        setDiscovering(true);
        setDiscoveryError(null);
        try {
            const found = await discover(host);
            setApiEndpoint(found.api);
            setCdnHost(found.cdn);
            setGatewayEndpoint(found.gateway);
            if (!name.trim() && found.name) setName(found.name);
            setType("advanced");
        } catch (e) {
            setDiscoveryError(e instanceof Error ? e.message : String(e));
        } finally {
            setDiscovering(false);
        }
    };

    const canSave = !!name.trim() && (type === "simple"
        ? !!host.trim()
        : !!(apiEndpoint.trim() && cdnHost.trim() && gatewayEndpoint.trim()));

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

        settings.store.customServers = existing
            ? settings.plain.customServers.map(s => (s.id === existing.id ? entry : s))
            : [...settings.plain.customServers, entry];

        onDone();
        if (id === connectedBackend) ChangeEndpoint.reapplyEndpoints();
    };

    return (
        <Card className={classes(Margins.top8, "vc-endpoint-form")}>
            <TextInput value={name} placeholder={"Display name (e.g. \"My Instance\")"} onChange={setName} />

            <div className={classes(Margins.top8, "vc-endpoint-type-toggle")}>
                <Button size="small" variant={type === "simple" ? "primary" : "secondary"} onClick={() => setType("simple")}>Simplified</Button>
                <Button size="small" variant={type === "advanced" ? "primary" : "secondary"} onClick={() => setType("advanced")}>Advanced</Button>
            </div>

            {type === "simple" ? (
                <>
                    <Paragraph className={Margins.top8}>Just the bare host, no scheme, no trailing slash (e.g. "rory.server.spacebar.chat"). Assumes the instance follows the standard api./cdn./gateway. convention.</Paragraph>
                    <TextInput value={host} placeholder="rory.server.spacebar.chat" onChange={setHost} />
                    <div className={classes(Margins.top8, "vc-endpoint-form-actions")}>
                        <Button size="small" variant="secondary" disabled={!host.trim() || discovering} onClick={findEndpoints}>
                            {discovering ? "Looking..." : "Find Endpoints"}
                        </Button>
                        <Paragraph size="sm" className="vc-endpoint-muted">
                            {discoveryError ?? "For servers that don't use api./cdn./gateway. subdomains. Fills in the advanced fields from what the server publishes."}
                        </Paragraph>
                    </div>
                </>
            ) : (
                <>
                    <Paragraph className={Margins.top8}>Each endpoint separately, for instances that don't follow the standard convention. Values come from https://&lt;host&gt;/api/policies/instance/domains. API needs a path (e.g. https://&lt;host&gt;/api) otherwise your server will fail to connect.</Paragraph>
                    <div className={Margins.top8}><TextInput value={apiEndpoint} placeholder="API endpoint" onChange={setApiEndpoint} /></div>
                    <div className={Margins.top8}><TextInput value={cdnHost} placeholder="CDN host" onChange={setCdnHost} /></div>
                    <div className={Margins.top8}><TextInput value={gatewayEndpoint} placeholder="Gateway endpoint" onChange={setGatewayEndpoint} /></div>
                    <div className={Margins.top8}><TextInput value={mediaProxyEndpoint} placeholder="Media proxy endpoint (optional, defaults to the CDN host)" onChange={setMediaProxyEndpoint} /></div>
                </>
            )}

            <div className={classes(Margins.top16, "vc-endpoint-form-actions")}>
                <Button size="small" disabled={!canSave} onClick={save}>{existing ? "Save Changes" : "Add Server"}</Button>
                <TextButton variant="primary" onClick={onDone}>Cancel</TextButton>
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
                <Button size="small" variant="secondary" onClick={linkedBackend ? unlinkCurrent : linkCurrent}>
                    {linkedBackend ? "Unlink" : `Link to ${serverName(backend)}`}
                </Button>
            </Card>

            {links.length > 0 && (
                <Paragraph size="sm" className={classes(Margins.top8, "vc-endpoint-muted")}>
                    {links.length} account{links.length === 1 ? "" : "s"} linked in total. Accounts link themselves
                    when they connect. Switching to an unlinked account asks which backend it belongs to first.
                </Paragraph>
            )}
        </>
    );
}

function RegistrationTokens() {
    const [tokens, setTokens] = useState<string[]>([]);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const generate = async () => {
        setGenerating(true);
        setError(null);
        try {
            const { body } = await RestAPI.get({ url: "/auth/generate-registration-tokens", query: { count: 1, length: 32 } });
            setTokens(previous => [...body.tokens, ...previous]);
        } catch (e) {
            setError((e as { body?: { message?: string; }; }).body?.message ?? "Couldn't generate a token.");
        } finally {
            setGenerating(false);
        }
    };

    return (
        <>
            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Registration Tokens</Heading>
            <Paragraph className={Margins.bottom16}>
                One time tokens that let someone register even while registration is closed. They go in the Registration Token box on the sign up page.
            </Paragraph>
            <Button size="small" variant="secondary" disabled={generating} onClick={generate}>
                {generating ? "Generating..." : "Generate Token"}
            </Button>
            {error && <Paragraph size="sm" className={classes(Margins.top8, "vc-endpoint-muted")}>{error}</Paragraph>}
            {tokens.map(token => (
                <Card key={token} className={classes(Margins.top8, "vc-endpoint-token-card")}>
                    <Paragraph size="sm" className="vc-endpoint-token">{token}</Paragraph>
                    <Button size="small" variant="secondary" onClick={() => copyWithToast(token)}>Copy</Button>
                </Card>
            ))}
        </>
    );
}

function EndpointTab() {
    settings.use(SETTING_KEYS);
    const [addingCustom, setAddingCustom] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);

    const { backend, customServers } = settings.store;
    const active = activeServerLabel();
    const info = ChangeEndpoint.instanceInfo();
    const switchPending = backend !== connectedBackend;
    const editingServer = editingId ? customServers.find(s => s.id === editingId) : undefined;

    const selectServer = (id: string) => {
        if (settings.store.backend === id) return;
        if (!hasEndpoints(id)) {
            Alerts.show({ title: "Missing Endpoints", body: `${serverName(id)} has no API or gateway set. Edit it before switching to it.`, confirmText: "Okay" });
            return;
        }
        if (id === connectedBackend) settings.store.backend = id;
        else ChangeEndpoint.switchBackend(id);
    };

    const removeCustomServer = (id: string) => {
        Alerts.show({
            title: "Remove Server?",
            body: `This removes "${serverName(id)}" from your server list.${settings.store.backend === id ? " You're connected to it, so you'll be switched to Spacebar." : ""}`,
            confirmText: "Remove",
            confirmColor: "danger",
            cancelText: "Cancel",
            onConfirm: () => {
                if (settings.store.backend === id) ChangeEndpoint.switchBackend(PREDEFINED_SERVERS[0].id);
                settings.store.customServers = settings.plain.customServers.filter(s => s.id !== id);
                settings.store.accountBackends = Object.fromEntries(Object.entries(settings.plain.accountBackends).filter(([, linked]) => linked !== id));
            }
        });
    };

    return (
        <div className="vc-endpoint-tab">
            <Card className="vc-endpoint-status-card">
                <div className="vc-endpoint-status-left">
                    <WebsiteIcon height={20} width={20} />
                    <div>
                        <Paragraph weight="bold">{switchPending ? `Not connected to ${active.name} yet` : `Connected to ${active.name}`}</Paragraph>
                        <Paragraph size="sm" className="vc-endpoint-muted">{active.host}</Paragraph>
                        {info?.instanceName && <Paragraph size="sm" className={Margins.top8}>{info.instanceName}</Paragraph>}
                        {info?.instanceDescription && <Paragraph size="sm" className="vc-endpoint-muted">{info.instanceDescription}</Paragraph>}
                        {(info?.frontPage || info?.tosPage || info?.correspondenceEmail) && (
                            <Paragraph size="sm" className={classes(Margins.top8, "vc-endpoint-instance-links")}>
                                {info.frontPage && <Link href={info.frontPage}>Website</Link>}
                                {info.tosPage && <Link href={info.tosPage}>Terms</Link>}
                                {info.correspondenceEmail && <span className="vc-endpoint-muted">Contact: {info.correspondenceEmail}</span>}
                            </Paragraph>
                        )}
                    </div>
                </div>
                <div className="vc-endpoint-status-right">
                    {switchPending
                        ? <Button size="small" onClick={() => location.reload()}>Reload</Button>
                        : <><DoubleCheckmarkIcon height={16} width={16} />Connected</>}
                </div>
            </Card>

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Servers</Heading>
            <Paragraph className={Margins.bottom16}>Pick the server to connect to. Switching happens right away, only going to or from Discord reloads the client.</Paragraph>

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
                            <Paragraph size="sm" className="vc-endpoint-muted">{server.type === "simple" ? server.host : server.apiEndpoint}</Paragraph>
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
                    <Button size="small" variant="secondary" onClick={() => setAddingCustom(true)}>
                        <PlusIcon height={14} width={14} /> Add Custom Server
                    </Button>
                </div>
            )}

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Accounts</Heading>
            <Paragraph className={Margins.bottom16}>
                Link the account you're currently on to the server selected above. Switching to a linked
                account from Discord's own account switcher switches to its server too.
            </Paragraph>
            <AccountLinkRow />

            {ChangeEndpoint.canCreateRegistrationTokens() && <RegistrationTokens />}
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
