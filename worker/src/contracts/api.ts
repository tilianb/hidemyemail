/** Pure JSON response DTOs shared with API clients. */
export interface CreateAliasInput {
  domain_id: number;
  local_part: string;
  destination?: string;
  label?: string | null;
}

export interface PatchAliasInput {
  active?: number;
  destination?: string | null;
  label?: string | null;
}

export interface AliasDto {
  id: number;
  domain_id: number;
  local_part: string;
  full_address: string;
  destination: string | null;
  label: string | null;
  active: 0 | 1;
  source: string;
  fwd_count: number;
  blocked_count: number;
  reply_count: number;
  created_at: number;
  last_seen_at: number | null;
  muted_until: number | null;
}

export interface DestinationDto {
  id: number;
  email: string;
  is_default: number;
  verified_at: number | null;
  created_at: number;
  suppressed_at: number | null;
  suppression_reason: string | null;
  suppression_class: string | null;
}
