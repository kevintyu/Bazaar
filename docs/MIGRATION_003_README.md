# Migration 003 — Conversations and Messaging

## Contents

- `supabase/migrations/20261110_003_conversations_messaging.sql`
- `supabase/tests/003_structural_checks.sql`
- `docs/MIGRATION_003_README.md`
- `docs/CODEX_MIGRATION_003_TASK.md`

## Requirements

Apply **after** the actual Migration 001 and Migration 002 used by the repository. The SQL assumes:

- `public.profiles`, `public.shops`, and `public.listings` exist;
- Migration 002's `listings.owner_user_id`, `listings.status`, `listings.moderation_status`, and `listings.shop_id` exist;
- `private.shop_is_publicly_eligible(uuid)` exists;
- the `private` schema is **not** exposed as a PostgREST API schema;
- Supabase Auth is configured with `auth.uid()` available in authenticated RPC calls.

Local applied history and runtime validation are recorded in `MIGRATION_003_VALIDATION.md`. No production deployment is authorized by this task. The separate compatibility migration supplies the missing eligibility helper without changing Migration 002.

## Added entities

### `conversations`

One conversation is tied to one Listing and contains exactly one buyer and its seller. The FK `(listing_id, seller_user_id) → (listings.id, listings.owner_user_id)` enforces seller identity. `UNIQUE(listing_id, buyer_user_id)` prevents duplicate threads for the same buyer and Listing.

Statuses:

- `active`: participants may exchange messages while the Listing is eligible;
- `concluded`: permanent history; no new messages via ordinary client RPC.

Conversations are automatically concluded if the Listing becomes `sold` or `removed`. The `reserved` Listing state **does not** conclude conversations; existing buyers may continue messaging under the owner-confirmed rule; new Conversations are blocked.

### `conversation_user_states`

Per-user `archived_at`, `hidden_at`, and `last_read_at`. Two rows are created automatically when a conversation starts. Archive/hide/read are independent for buyer and seller. Hiding **does not delete chat history**. A new incoming text message unhides and unarchives the receiver's conversation.

### `messages`

Immutable text/system-message records (no direct client mutations). Text messages must have a real participant sender and `client_message_id`, and are limited to 4,000 characters. A sender's client message UUID is unique, allowing retry without duplicates. System messages have no user sender and are reserved for future trusted backend events.

## Public RPCs

| RPC | Arguments | Outcome |
|---|---|---|
| `start_conversation` | `p_listing_id` | Conversation UUID. Repeated request for same buyer + Listing returns existing ID while the listing is eligible. |
| `send_message` | `p_conversation_id`, `p_body`, `p_client_message_id` | Message UUID. Validates participant, active account, live conversation, eligible Listing. |
| `set_conversation_archived` | `p_conversation_id`, `p_archived` | Archives/unarchives only caller's inbox state. |
| `set_conversation_hidden` | `p_conversation_id`, `p_hidden` | Hides/unhides only caller's inbox state. |
| `mark_conversation_read` | `p_conversation_id` | Advances the caller's last-read timestamp. |

The frontend never supplies `sender_user_id`, `seller_user_id`, or `buyer_user_id` in the RPCs; identities derive from `auth.uid()` and Listing ownership.

### Client example

```ts
// Buyer starts a thread from a Listing page.
const { data: conversationId, error: startError } = await supabase.rpc(
  'start_conversation',
  { p_listing_id: listingId }
);

// Generate once PER actual message and reuse on transport retries.
const clientMessageId = crypto.randomUUID();
const { data: messageId, error: sendError } = await supabase.rpc(
  'send_message',
  {
    p_conversation_id: conversationId,
    p_body: 'Is the item still available?',
    p_client_message_id: clientMessageId,
  }
);
```

Because `start_conversation` and `send_message` are currently separate, an empty conversation can briefly exist if the first message fails or is abandoned. A later UI slice may introduce a combined atomic `start_conversation_with_message()` operation, after discussing the UX tradeoff.

## Read and pagination examples

```ts
// Participant-scoped RLS allows only your own threads.
const { data: threads } = await supabase
  .from('conversations')
  .select('id, listing_id, buyer_user_id, seller_user_id, status, last_message_at, created_at')
  .order('last_message_at', { ascending: false, nullsFirst: false });

// The client should filter by conversation_id and paginate by
// created_at + id for stable long histories.
const { data: messages } = await supabase
  .from('messages')
  .select('id, conversation_id, sender_user_id, type, body, created_at')
  .eq('conversation_id', conversationId)
  .order('created_at', { ascending: false })
  .order('id', { ascending: false })
  .limit(40);
```

To hide archived or hidden conversations from the main inbox, query the current user's `conversation_user_states` and use the corresponding timestamps. Avoid exposing other participants' inbox-state rows; RLS permits only one's own.

## Realtime delivery (MVP)

Migration 003 adds `public.messages` and `public.conversations` to the existing `supabase_realtime` publication **if** it exists. It does not drop/recreate the publication. In a Supabase-managed database, Postgres Changes delivers persistent rows only to subscribers allowed by `SELECT` + RLS.

```ts
const channel = supabase
  .channel(`conversation:${conversationId}`)
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${conversationId}`,
    },
    ({ new: message }) => {
      // Merge by message.id; do not blindly append duplicates.
      // Also fetch missing history when the socket reconnects.
    }
  )
  .subscribe();

// On component unmount:
await supabase.removeChannel(channel);
```

**Delivery model:** Postgres is the source of truth; WebSocket events are hints for a live UI, not a guaranteed receipt or a substitute for paginated reads. Handle reconnects, missed events, optimistic updates, and duplicate arrivals.

**Scalability choice:** Current Supabase guidance prefers Broadcast for higher-scale realtime applications. Postgres Changes is easier to begin with; consider a private Broadcast channel plus `realtime.messages` authorization when testing shows the need. Source: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes

## Authorization design

- All three messaging tables: RLS enabled; `anon` has no read privileges.
- `authenticated` can only `SELECT`; row access is restricted to the two conversation participants, or own inbox state.
- `start_conversation` and `send_message` are the ONLY v1 client write paths to the message/conversation entities.
- Caller identity comes from `auth.uid()` in guarded private implementation functions.
- Private `SECURITY DEFINER` functions have `set search_path = ''`, explicit schema-qualified SQL, and must **never** be exposed through Supabase Data API schemas.
- No public `system`-message RPC. Later transaction events will use a trusted internal path.

### Listing eligibility

A new Conversation requires `active`. New messages in an existing Conversation allow `active` or `reserved`. Both require moderation `clear` and a publicly eligible Shop + seller account. Existing histories remain readable when the item is sold, removed, or subject to moderation.

Account suspension rejects new messages, but retained private conversation history remains accessible to the account for now. This should be revisited alongside reporting/dispute policy.

## Required behavior checks in addition to structural test

| Scenario | Expected |
|---|---|
| Buyer A starts thread on active clear Listing | Succeeds |
| Buyer A starts same thread again | Same conversation ID |
| Buyer B starts thread on same Listing | Distinct conversation |
| Seller starts conversation about their own Listing | Denied |
| Buyer starts thread on someone else's draft/removed Listing | Denied |
| Buyer starts NEW thread on reserved Listing | Denied (owner-confirmed) |
| Existing buyer/seller sends while reserved | Allowed, including other existing buyers |
| Buyer starts thread on `under_review` Listing | Denied |
| Suspended/banned buyer starts thread | Denied |
| Unauthenticated User starts conversation | Denied |
| A participant sends valid text | Message created |
| Third-party User reads Conversation/Messages | Returns no rows |
| Third-party User calls send_message | Denied |
| Client tries to insert `system` message | Denied |
| Sender retries same UUID and same text | Same Message UUID, no second row |
| Sender retries UUID with different text/conversation | Denied |
| User archives thread | Only user's state changes |
| User hides thread | History retained; only user's view hidden |
| Recipient receives another message | Recipient state unhidden/unarchived |
| Listing moves ACTIVE → REMOVED | All its Conversations concluded |
| Message sent after conclusion | Denied |
| Realtime subscriber is a participant | Gets INSERT event |
| Realtime subscriber is not a participant | Gets no private event |
| Browser refresh/reconnect | Missing message history is recoverable from Postgres |

Also test two overlapping sends (same client ID) and a concurrent remove/send; one request may be retried, but an invalid partial state must not persist.

## Explicit deferrals

- `Reserve for this buyer` action (Migration 004 Transactions).
- Admin/system-message write API and transaction event messages.
- Reporting, blocking, abuse/rate limiting, spam detection.
- Image/file attachments, typing indicators, read receipts displayed to the other user.
- Chat retention and legal deletion/anonymization rules.
- Automatic cleanup of never-messaged empty conversations.
- Combined atomic create-conversation-and-first-message action.
- Realtime Broadcast migration and delivery observability.

## Validation status

Applied local history verified 2026-11-11: 001, 002, compatibility, 003. See `MIGRATION_003_VALIDATION.md` for current executed checks and blockers. Applied SQL files remain unchanged; historical provisional comments are superseded by `MESSAGING_POLICY_DECISION.md`.
