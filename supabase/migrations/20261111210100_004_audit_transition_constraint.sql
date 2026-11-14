-- Forward-only correction to the applied 004 foundation.
-- CHECK accepts NULL, so cancellation must explicitly require a previous state.
alter table public.transaction_events drop constraint transaction_events_transition;
alter table public.transaction_events add constraint transaction_events_transition check (
  (from_status is null and to_status = 'reserved' and cancellation_reason is null)
  or (from_status is not null and from_status = 'reserved' and to_status = 'cancelled')
);
