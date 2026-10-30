export interface ProbePathFact {
  logical_root: string
  canonical_root: string | null
  exists: boolean | null
  type: 'directory' | 'file' | 'symlink' | 'other' | 'unknown'
  is_directory: boolean
  is_symbolic_link: boolean
  parent_symlink: boolean | null
  realpath_status: string
  readable: boolean | null
  writable: boolean | null
  traversal: 'allowed' | 'blocked' | 'not_applicable'
}

export interface ProbeLayout {
  root: string
  app_exists: boolean
  users_exists: boolean
  user_count: number
  users: Array<{ user_directory_hash: string; history_exists: boolean; wch_count: number; wch_hashes: string[] }>
  legacy_exists: boolean
  directories: number
  files: number
  symlinks: number
  extension_counts: Record<string, number>
  sample_relative_paths: string[]
  truncated: boolean
}

export interface MacWorkBuddyProbeReport {
  report_schema: 'macos-workbuddy-probe-v1'
  generated_at: string
  private_radar: { version: string; is_packaged: boolean; electron_version: string; node_version: string; user_data_path: string }
  system: { macos_version: string | null; darwin_version: string; cpu_architecture: string; process_arch: string }
  workbuddy_app: Array<ProbePathFact & { bundle_identifier: string | null; version: string | null; build: string | null; executable: string | null; sandbox: boolean | null; group_container_count: number }>
  workbuddy_roots: ProbePathFact[]
  chat_history_layout: ProbeLayout[]
  mcp: Array<{ root: string; exists: boolean | null; json_valid: boolean | null; server_count: number | null; privateradar_present: boolean | null; approvals_exists: boolean | null; approvals_json_valid: boolean | null; privateradar_approval_present: boolean | null; private_radar_launch: { command_class: string; args_count: number; cwd_class: string; env_key_count: number } | null }>
  skills: Array<{ root: string; exists: boolean | null; entry_count: number; private_radar_present: boolean; truncated: boolean }>
  runtime: { env_node_resolves: boolean; executable_path_class: string; node_version: string | null; bundled_node_candidates: Array<{ app: string; relative_path: string; exists: boolean }> }
  filesystem: Array<{ root: string; statfs_type: number | null; filesystem_type: string | null; case_sensitive: boolean | null; unicode_nfc: boolean; unicode_nfd: boolean; alias_resolution: 'not_attempted' }>
  capability: { read_only: true; connector_registration: 'not_tested'; stdio_mcp: 'not_tested'; tcc: 'not_inferred'; real_mac_workbuddy_validated: false }
  privacy_redactions: string[]
  errors: Array<{ scope: string; code: string }>
}

export interface MacWorkBuddyProbeApi {
  run: () => Promise<MacWorkBuddyProbeReport>
  exportReport: () => Promise<{ status: 'saved' | 'cancelled' | 'failed'; message: string }>
}
