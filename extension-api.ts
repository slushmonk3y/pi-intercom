import type { SessionInfo } from "./types.ts";

export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";
export const INTERCOM_OUTBOX_REQUEST_EVENT = "intercom:outbox-request";
export const INTERCOM_OUTBOX_RESULT_EVENT = "intercom:outbox-result";
export const INTERCOM_SESSION_IDENTITY_EVENT = "intercom:session-identity";
/** `namespace@version` naming the delivery policy a managed launch requires before any admission. */
export const INTERCOM_REQUIRED_POLICY_ENV = "PI_INTERCOM_REQUIRED_POLICY";

/**
 * Emitted on the session's own event bus at session start, before the intercom
 * ID is chosen. An extension that owns this session's routing address (for
 * example a subagent launcher) calls `claim` synchronously; the first non-empty
 * claim becomes this session's intercom ID and wins over `PI_INTERCOM_STABLE_ID`
 * and `stableId`, which are process- and machine-wide. The session name stays
 * free for a human-readable label.
 */
export interface IntercomSessionIdentityRequestV1 {
  version: 1;
  claim(stableId: string): void;
}

export type IntercomOutboxResultStatus = "sent" | "rejected" | "blocked" | "failed";

export type IntercomOutboxResultCode =
  | "user_cancelled"
  | "confirmation_unavailable"
  | "session_unavailable"
  | "session_ended"
  | "invalid_request"
  | "duplicate_request"
  | "target_not_found"
  | "target_ambiguous"
  | "self_target"
  | "delivery_failed";

export interface IntercomOutboxRequestV1 {
  version: 1;
  requestId: string;
  extensionId: string;
  extensionName: string;
  to: string;
  message: string;
}

export type IntercomOutboxRequest = IntercomOutboxRequestV1;

export interface IntercomOutboxResultV1 {
  version: 1;
  requestId: string;
  status: IntercomOutboxResultStatus;
  code?: IntercomOutboxResultCode;
  extensionId?: string;
  extensionName?: string;
  messageId?: string;
  detail?: string;
}

export type IntercomOutboxResult = IntercomOutboxResultV1;

export interface IntercomExtensionOwner {
  sessionId: string;
  epoch: string;
}

export interface IntercomExtensionState {
  revision: number;
  payload: unknown;
}

export type IntercomExtensionEvent =
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "owner"; owner?: IntercomExtensionOwner }
  | { type: "message"; fromSessionId: string; owner?: IntercomExtensionOwner; payload: unknown }
  | { type: "state"; state: IntercomExtensionState }
  | { type: "state_result"; committed: boolean; revision: number; reason?: string }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionInfo }
  /** This session's own broker identity, sent after each registration. */
  | { type: "identity"; sessionId: string; endpointEpoch?: string; connectionGeneration: number };

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): {
    connected: boolean;
    supported: boolean;
    owner?: IntercomExtensionOwner;
    state?: IntercomExtensionState;
  };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  commitState(payload: unknown, expectedRevision?: number): void;
  listSessions(): Promise<SessionInfo[]>;
  /** Present only when the registration supplied a policy. */
  readonly policy?: IntercomPolicyHandle;
}

/**
 * One delivery decision point for every route that exposes content to this session's model or
 * sends on its behalf. Decisions are synchronous; throwing, malformed or thenable results fail
 * closed (inbound: retain, outbound: deny).
 */
export interface IntercomDeliveryEvent {
  version: 1;
  direction: "inbound" | "outbound";
  /** inbound: message | relay | reply-waiter; outbound: send | ask | reply */
  route: "message" | "relay" | "reply-waiter" | "send" | "ask" | "reply";
  messageId: string;
  /** Inbound sender, or this session for outbound. */
  from?: { id: string; name?: string };
  /** Outbound target as requested. */
  to?: string;
  replyTo?: string;
  expectsReply?: boolean;
  /** Text the model would see (inbound) or that would be sent (outbound), attachments included. */
  text: string;
}

export type IntercomDeliveryDecision =
  /** `details` is merged into the delivered custom message's details: correlation only, never authority. */
  | { action: "allow"; details?: Record<string, unknown> }
  /** Inbound only: kept in Intercom's queue, re-decided on policy notification. Outbound treats it as deny. */
  | { action: "retain"; reason: string }
  | { action: "deny"; reason: string };

export interface IntercomHandoverEvent {
  version: 1;
  route: "tool" | "command" | "overlay";
  crossMachine: boolean;
}

export type IntercomHandoverDecision = { action: "allow" } | { action: "deny"; reason: string };

export interface IntercomPolicyV1 {
  version: 1;
  /** Runs before handover generation, Git reads and any delayed send. */
  handover(event: IntercomHandoverEvent): IntercomHandoverDecision;
  delivery(event: IntercomDeliveryEvent): IntercomDeliveryDecision;
}

/**
 * Owner control of a registered policy. A policy starts inactive: while it is inactive, or after
 * dispose, inbound content is retained and handover and outbound sends are refused.
 */
export interface IntercomPolicyHandle {
  readonly active: boolean;
  activate(): void;
  deactivate(): void;
  dispose(): void;
  /** Re-decide retained inbound content, for example after a hold is released. */
  notify(): void;
}

export interface IntercomExtensionRegistration {
  namespace: string;
  ownerEligible: boolean;
  onEvent(event: IntercomExtensionEvent): void;
  onReady(channel: IntercomExtensionChannel): void;
  /** At most one registration per runtime may own a policy; re-registering the same object is idempotent. */
  policy?: IntercomPolicyV1;
}
