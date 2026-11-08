export type ListingStatus = 'draft' | 'active' | 'reserved' | 'sold' | 'removed';
export type ListingCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor';
export type RemovalReason =
  | 'sold_elsewhere'
  | 'no_longer_selling'
  | 'item_lost_or_damaged'
  | 'duplicate_or_mistake'
  | 'wants_to_change_listing'
  | 'other';

export type ListingImage = {
  id: string;
  listing_id: string;
  storage_path: string;
  alt_text: string | null;
  sort_order: number;
};

export type Listing = {
  id: string;
  shop_id: string;
  owner_user_id: string;
  title: string | null;
  description: string | null;
  asking_price: number | null;
  currency: string | null;
  category_key: string | null;
  condition: ListingCondition | null;
  status: ListingStatus;
  moderation_status: 'clear' | 'under_review';
  created_at: string;
  published_at: string | null;
};

export const CATEGORIES = [
  { key: 'furniture', label: 'Furniture' },
  { key: 'electronics', label: 'Electronics' },
  { key: 'books', label: 'Books' },
  { key: 'clothing', label: 'Clothing' },
  { key: 'other', label: 'Other' },
] as const;

// The above are temporary UI categories, NOT a legal permitted-item policy.

export const CONDITIONS: ListingCondition[] = ['new','like_new','good','fair','poor'];

export const REMOVAL_REASONS: { value: RemovalReason; label: string }[] = [
  { value: 'sold_elsewhere', label: 'Sold somewhere else' },
  { value: 'no_longer_selling', label: 'No longer selling' },
  { value: 'item_lost_or_damaged', label: 'Item lost or damaged' },
  { value: 'duplicate_or_mistake', label: 'Duplicate or listing mistake' },
  { value: 'wants_to_change_listing', label: 'Want to change the listing' },
  { value: 'other', label: 'Other' },
];
