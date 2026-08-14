// Read-only Gmail integration: OAuth token exchange/refresh and inbox search, used to surface
// possible replies from companies the candidate has applied to (see index.ts's /gmail/* routes).
// Read-only by construction -- the only scope this ever requests is gmail.readonly, and nothing
// here calls a Gmail write/send/modify endpoint.

import { fetchWithTimeout } from "./companies";

export type GmailConnection = {
  email_address: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  connected_at: string;
  /** Set once a refresh attempt hits invalid_grant (Testing-mode 7-day expiry, or a revoked grant).
   * Kept in storage rather than only ever thrown, so GET /gmail/status can surface "needs
   * reconnecting" from a passive read -- it must never itself attempt a live refresh (see index.ts). */
  needs_reconnect?: boolean;
};

/** Parses candidate_profiles.gmail_json. No refresh_token means "not connected", regardless of what else is stored. */
export function readGmailConnection(gmailJson: string): GmailConnection | null {
  try {
    const parsed = JSON.parse(gmailJson || "{}") as Partial<GmailConnection>;
    if (!parsed.refresh_token) return null;
    return {
      email_address: parsed.email_address ?? "",
      access_token: parsed.access_token ?? "",
      refresh_token: parsed.refresh_token,
      token_expires_at: parsed.token_expires_at ?? "",
      connected_at: parsed.connected_at ?? "",
      needs_reconnect: Boolean(parsed.needs_reconnect),
    };
  } catch {
    return null;
  }
}

/** The user's own Google OAuth app registration -- see candidate_profiles.google_oauth_json. */
export type GoogleOAuthClient = {
  client_id: string;
  client_secret: string;
  saved_at: string;
};

export function readGoogleOAuthClient(json: string): GoogleOAuthClient | null {
  try {
    const parsed = JSON.parse(json || "{}") as Partial<GoogleOAuthClient>;
    if (!parsed.client_id || !parsed.client_secret) return null;
    return { client_id: parsed.client_id, client_secret: parsed.client_secret, saved_at: parsed.saved_at ?? "" };
  } catch {
    return null;
  }
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/** The Client ID/Secret the user entered don't authenticate with Google -- distinct from a
 * transient failure so the UI can point back at Settings > Email's credentials form specifically. */
export class GmailInvalidClientError extends Error {
  constructor() {
    super("gmail_invalid_client");
    this.name = "GmailInvalidClientError";
  }
}

/** The redirect URI used didn't match what's registered on the Google OAuth client. */
export class GmailRedirectMismatchError extends Error {
  constructor() {
    super("gmail_redirect_mismatch");
    this.name = "GmailRedirectMismatchError";
  }
}

function classifyTokenEndpointError(data: TokenResponse, fallback: string): Error {
  if (data.error === "invalid_client") return new GmailInvalidClientError();
  if (data.error === "redirect_uri_mismatch") return new GmailRedirectMismatchError();
  return new Error(`${fallback}: ${data.error_description || data.error || "unknown_error"}`);
}

/** Exchanges a fresh OAuth `code` for tokens right after the user completes Google's consent screen. */
export async function exchangeGmailCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const res = await fetchWithTimeout(TOKEN_ENDPOINT, 10000, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res) throw new Error("gmail_token_exchange_unreachable");
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error) throw classifyTokenEndpointError(data, "gmail_token_exchange_failed");
  // access_type=offline + prompt=consent (see index.ts's /gmail/connect) guarantee a refresh_token
  // comes back even on a reconnect -- if it's missing here despite an ok response, something about
  // the consent request itself is misconfigured, not a normal failure worth swallowing.
  if (!data.access_token || !data.refresh_token) {
    throw new Error("gmail_token_exchange_failed: missing_tokens_in_response");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  };
}

/** The connected mailbox's address, fetched right after exchange so the UI can show "Connected as X". */
export async function fetchGmailAddress(accessToken: string): Promise<string> {
  const res = await fetchWithTimeout(`${GMAIL_API}/profile`, 10000, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res || !res.ok) return "";
  const data = (await res.json().catch(() => ({}))) as { emailAddress?: string };
  return data.emailAddress ?? "";
}

/** Best-effort: revoking with Google is a courtesy, not something a disconnect should ever fail on. */
export async function revokeGmailToken(token: string): Promise<void> {
  await fetchWithTimeout(REVOKE_ENDPOINT, 5000, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => null);
}

/** Distinct from a transient failure -- the UI should prompt reconnecting, not just show an error. */
export class GmailReconnectRequiredError extends Error {
  constructor() {
    super("gmail_reconnect_required");
    this.name = "GmailReconnectRequiredError";
  }
}

/**
 * Returns a valid access token, refreshing first if the stored one is expired or about to be.
 * Refresh tokens from a Testing-status OAuth consent screen -- the simplest path for a personal
 * Gmail account, see the "Gmail reply-checking" section of the README -- expire after 7 days, at
 * which point Google returns invalid_grant and the only fix is clicking Connect again.
 */
export async function refreshGmailAccessToken(
  clientId: string,
  clientSecret: string,
  connection: GmailConnection,
): Promise<{ accessToken: string; expiresAt: string }> {
  const expiresAt = new Date(connection.token_expires_at || 0).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: connection.access_token, expiresAt: connection.token_expires_at };
  }
  const res = await fetchWithTimeout(TOKEN_ENDPOINT, 10000, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res) throw new Error("gmail_refresh_unreachable");
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (data.error === "invalid_grant") throw new GmailReconnectRequiredError();
  if (!res.ok || data.error) throw classifyTokenEndpointError(data, "gmail_refresh_failed");
  if (!data.access_token) throw new Error("gmail_refresh_failed: missing_access_token_in_response");
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export type GmailMatch = {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
};

/**
 * Below this length a plain phrase search returns mostly noise -- not a partial-word-match
 * problem (Gmail's `q` already matches whole words, not substrings), but that a short generic
 * name is genuinely likely to appear in unrelated mail on its own.
 */
export function isSearchableCompanyName(normalizedName: string): boolean {
  return normalizedName.trim().length > 3;
}

/** Searches the connected inbox for mail plausibly from `companyName`, sent on or after `sinceDate`. */
export async function searchGmailForCompany(
  accessToken: string,
  companyName: string,
  sinceDate: Date,
  limit = 5,
): Promise<GmailMatch[]> {
  const dateStr = sinceDate.toISOString().slice(0, 10).replace(/-/g, "/");
  const q = `"${companyName}" after:${dateStr} -in:sent -in:chats`;
  const listRes = await fetchWithTimeout(
    `${GMAIL_API}/messages?${new URLSearchParams({ q, maxResults: String(limit) }).toString()}`,
    10000,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!listRes) throw new Error("gmail_search_unreachable");
  if (!listRes.ok) throw new Error(`gmail_search_failed_${listRes.status}`);
  const listData = (await listRes.json().catch(() => ({}))) as { messages?: { id: string }[] };
  const ids = (listData.messages ?? []).map((m) => m.id);
  if (!ids.length) return [];

  // Sequential, not pooled -- at most `limit` (default 5) messages for one company. Concurrency
  // across companies happens one level up, in index.ts's checkGmailReplies via runPooled.
  const results: GmailMatch[] = [];
  for (const id of ids) {
    const params = new URLSearchParams({ format: "metadata" });
    params.append("metadataHeaders", "Subject");
    params.append("metadataHeaders", "From");
    params.append("metadataHeaders", "Date");
    const msgRes = await fetchWithTimeout(`${GMAIL_API}/messages/${id}?${params.toString()}`, 10000, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!msgRes || !msgRes.ok) continue;
    const msg = (await msgRes.json().catch(() => null)) as {
      id?: string;
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] };
    } | null;
    if (!msg) continue;
    const header = (name: string): string =>
      msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    results.push({
      id: msg.id ?? id,
      subject: header("Subject"),
      from: header("From"),
      date: header("Date"),
      snippet: msg.snippet ?? "",
    });
  }
  return results;
}
