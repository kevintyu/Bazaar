# Messaging policy decision record

Status: OWNER-CONFIRMED, 2026-11-11.

Confirmed in "Branch · App Stack Challenges" and the current repository task:
new Conversations are blocked while a Listing is RESERVED; all existing
Conversations may continue, including those with buyers not selected for reservation.

| Listing state | New Conversation | Existing Conversation |
|---|---|---|
| DRAFT | Blocked | N/A |
| ACTIVE, CLEAR, eligible Shop/seller | Allowed | May send |
| RESERVED, CLEAR, eligible Shop/seller | Blocked | May send |
| SOLD | Blocked | Concluded/read-only |
| REMOVED | Blocked | Concluded/read-only |
| UNDER_REVIEW | Blocked | Sending blocked; history retained |

Cancellation returning a Listing to ACTIVE allows new Conversations again.
The existing applied Migration 003 already implements the RESERVED distinction.
Its historical provisional SQL comments are preserved, not rewritten. The current
policy is recorded in DOMAIN_MODEL.md and DOMAIN_OPERATIONS.md.

start_conversation checks ACTIVE before returning an existing ID; clients must
read/reopen their existing Conversation rather than call start while RESERVED.
Account and Shop eligibility restrictions still apply. Post-sale support through
a separate conversation type is not implemented. Retention and active-transaction
suspension/blocking behavior remain open business decisions.
