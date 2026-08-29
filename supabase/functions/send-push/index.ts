// ─────────────────────────────────────────────────────────────────────
// send-push
//
// The "ping" side of the permanent link. Called by the Quest Book app
// (and could be triggered by a DB webhook) whenever a user's data row is
// written. It looks up every Web Push subscription for that user and
// immediately wakes each device's service worker, excluding the device
// that made the change (sent via `excludeEndpoint`).
//
// The receiving service worker shows a notification and fetches + caches
// the freshest payload so the next (even offline) open has recent data.
//
// Invoke: POST /functions/v1/send-push  (Authorization: Bearer <anon or sb_publishable>)
//   body: { "userId": "<uuid>", "excludeEndpoint": "<https://...>" , "title"?, "body"? }
// ─────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// web-push is a Node package; Supabase's Edge runtime supports npm: specifiers.
const webpush = await import("npm:web-push@3.6.7");

Deno.serve(async (req) => {
  // CORS for the static GitHub Pages origin. Requests carry the
  // anon/publishable key; the function switches to service_role to read
  // subscriptions and send pushes (bypassing RLS).
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ||
      "https://mqngospkwckguveypnju.supabase.co";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!serviceKey || !vapidPublic || !vapidPrivate) {
      return new Response(
        JSON.stringify({ error: "Push not configured (missing secrets)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    webpush.setVapidDetails(
      "mailto:admin@questbook.app",
      vapidPublic,
      vapidPrivate
    );

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let body = {};
    try { body = await req.json(); } catch (_) {}
    const userId = body.userId;
    const excludeEndpoint = body.excludeEndpoint || "";
    const action = body.action || "sync";
    const title = body.title || "Quest Book updated";
    const message = body.body || "Your questbook changed on another device.";

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "userId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", userId);

    if (error) throw error;

    const targets = (subs || []).filter((s) => s.endpoint !== excludeEndpoint);
    let sent = 0;
    const failures = [];

    for (const sub of targets) {
      try {
        const payload = JSON.stringify({
          action,
          title,
          body: message,
          url: "/",
        });

        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { TTL: 300 }
        );
        sent++;
        await supabase
          .from("push_subscriptions")
          .update({ last_ping_at: new Date().toISOString() })
          .eq("id", sub.id);
      } catch (e) {
        // 404/410 means the endpoint is dead (subscriber uninstalled or
        // cleared data) — clean it up so we don't keep pinging a tombstone.
        const status = e && e.statusCode;
        if (status === 404 || status === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          failures.push({ endpoint: sub.endpoint, error: String(e && e.message || e) });
        }
      }
    }

    return new Response(
      JSON.stringify({ sent, total: targets.length, failures }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e && e.message || e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
