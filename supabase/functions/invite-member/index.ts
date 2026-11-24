import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const appOrigin = Deno.env.get("APP_ORIGIN") || "https://hazelnyle.github.io";
const appBaseUrl = Deno.env.get("APP_BASE_URL") || "https://hazelnyle.github.io/MINTLY-App";
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function respond(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("Missing required invite-member environment secrets.");
    return respond(500, { error: "Invitation service is not configured. Contact the app administrator." });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return respond(401, { error: "Sign in before sending an invitation." });

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) return respond(401, { error: "Your session is invalid or expired. Sign in again." });

  let body: { space_id?: string; email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return respond(400, { error: "Request body must be valid JSON." });
  }

  const spaceId = body.space_id?.trim();
  const email = body.email?.trim().toLowerCase();
  const role = body.role;

  if (!spaceId || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(400, { error: "Enter a valid email address and choose a household." });
  }
  if (role !== "editor" && role !== "viewer") {
    return respond(400, { error: "Invitation permission must be editor or viewer." });
  }

  const { data: space, error: spaceError } = await admin
    .from("spaces").select("id,kind").eq("id", spaceId).maybeSingle();
  if (spaceError || !space || space.kind !== "household") {
    return respond(404, { error: "Household not found." });
  }

  const { data: membership, error: membershipError } = await admin
    .from("space_members").select("role").eq("space_id", spaceId)
    .eq("user_id", userData.user.id).maybeSingle();
  if (membershipError) {
    console.error("Membership lookup failed:", membershipError);
    return respond(500, { error: "Could not verify your household permissions." });
  }
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return respond(403, { error: "Only household owners and admins can invite members." });
  }

  const { data: existingMember } = await admin
    .from("space_members").select("user_id")
    .eq("space_id", spaceId)
    .in("user_id", (await admin.from("profiles").select("id").ilike("email", email)).data?.map((p: {id:string}) => p.id) || []);
  if (existingMember?.length) return respond(409, { error: "That person is already a member of this household." });

  const { error: invitationError } = await admin.from("invitations").upsert({
    space_id: spaceId,
    email,
    role,
    invited_by: userData.user.id,
    status: "pending"
  }, { onConflict: "space_id,email" });
  if (invitationError) {
    console.error("Could not save invitation:", invitationError);
    return respond(500, { error: "Could not save the household invitation. Please try again." });
  }

  const redirectTo = appOrigin ? `${appOrigin.replace(/\/$/, "")}/` : undefined;
  const { error: emailError } = await admin.auth.admin.inviteUserByEmail(email, {
    ...(redirectTo ? { redirectTo } : {}),
    data: { invited_to_space: spaceId }
  });

  if (emailError) {
    console.error("Supabase invitation email failed:", emailError);
    await admin.from("invitations").delete().eq("space_id", spaceId).eq("email", email).eq("invited_by", userData.user.id);
    const detail = emailError.message || "Email provider rejected the invitation.";
    return respond(502, { error: `Invitation email could not be sent: ${detail}` });
  }

  return respond(200, { message: `Invitation sent to ${email}.` });
});
