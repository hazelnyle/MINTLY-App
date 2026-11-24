import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const appOrigin = Deno.env.get("APP_ORIGIN") || "https://hazelnyle.github.io";
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
    console.error("Missing required accept-invitations environment secrets.");
    return respond(500, { error: "Invitation acceptance is not configured. Contact the app administrator." });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return respond(401, { error: "Sign in before accepting an invitation." });

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Never accept an email or user ID supplied by the browser. Resolve both
  // from the verified access token instead.
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const signedInUser = userData?.user;
  const email = signedInUser?.email?.trim().toLowerCase();

  if (userError || !signedInUser || !email) {
    return respond(401, { error: "Your session is invalid or has no verified email. Sign in again." });
  }

  const { data: invitations, error: invitationLookupError } = await admin
    .from("invitations")
    .select("id,space_id,role")
    .eq("email", email)
    .eq("status", "pending");

  if (invitationLookupError) {
    console.error("Pending invitation lookup failed:", invitationLookupError);
    return respond(500, { error: "Could not look up pending household invitations." });
  }

  let acceptedCount = 0;
  const failures: string[] = [];

  for (const invitation of invitations || []) {
    const { data: space, error: spaceError } = await admin
      .from("spaces")
      .select("id,kind")
      .eq("id", invitation.space_id)
      .maybeSingle();

    if (spaceError || !space || space.kind !== "household") {
      failures.push("A household invitation could not be validated.");
      continue;
    }

    // Do not overwrite an existing member's role. For a new member, the
    // role comes only from the pending invitation row.
    const { error: membershipError } = await admin
      .from("space_members")
      .upsert({
        space_id: invitation.space_id,
        user_id: signedInUser.id,
        role: invitation.role
      }, {
        onConflict: "space_id,user_id",
        ignoreDuplicates: true
      });

    if (membershipError) {
      console.error("Could not add invited household member:", membershipError);
      failures.push("Could not add you to one of the invited households.");
      continue;
    }

    const { error: updateError } = await admin
      .from("invitations")
      .update({ status: "accepted" })
      .eq("id", invitation.id)
      .eq("status", "pending");

    if (updateError) {
      console.error("Could not mark invitation accepted:", updateError);
      failures.push("You were added, but an invitation status could not be updated.");
      continue;
    }

    acceptedCount += 1;
  }

  return respond(200, {
    accepted_count: acceptedCount,
    pending_count: (invitations || []).length,
    ...(failures.length ? { warnings: failures } : {})
  });
});
