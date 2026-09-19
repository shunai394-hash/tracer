import "server-only";

function present(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

export type FoundationStatus = {
  supabasePublic: boolean;
  supabaseServiceRole: boolean;
  gemini: boolean;
  brightData: boolean;
  brightDataMcp: boolean;
};

export function getFoundationStatus(): FoundationStatus {
  return {
    supabasePublic: present(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      present(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRole: present(process.env.SUPABASE_SERVICE_ROLE_KEY),
    gemini: present(process.env.GEMINI_API_KEY),
    brightData: present(process.env.BRIGHTDATA_API_TOKEN),
    brightDataMcp: present(process.env.BRIGHTDATA_MCP_URL),
  };
}

export function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  return { apiKey, model };
}

export function getBrightDataConfig() {
  return {
    apiToken: process.env.BRIGHTDATA_API_TOKEN?.trim() ?? "",
    zone: process.env.BRIGHTDATA_ZONE?.trim() ?? "",
    mcpUrl: process.env.BRIGHTDATA_MCP_URL?.trim() ?? "",
  };
}

export function getSupabasePublicConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
  };
}

export function getSupabaseServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
}

export function getCJConfig() {
  return {
    apiKey: process.env.CJ_API_KEY?.trim() ?? "",
  };
}
