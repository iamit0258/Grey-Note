import { createClient } from "@supabase/supabase-js";
import { UAParser } from "ua-parser-js";
import { formatDistanceToNow } from "date-fns";

// --- Supabase Config ---
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
// Note: We create the client initially with anon key, but we'll update it with the JWT for auth operations
let supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- Auth State ---
let isClerkLoaded = false;

// --- Session Tracking ---
const pageLoadTime = Date.now();
let visitCount = parseInt(localStorage.getItem("visit_count") || "0") + 1;
localStorage.setItem("visit_count", visitCount.toString());

// --- Utilities ---
function escapeHTML(str: string) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function getUsername(user: any) {
    if (user.username) return user.username;
    const firstName = user.firstName || "";
    const lastName = user.lastName || "";
    if (firstName || lastName) {
        return (firstName + lastName).replace(/[^a-zA-Z0-9]/g, "");
    }
    return user.externalAccounts?.[0]?.username || user.id.slice(-8);
}

async function getSupabaseClient() {
    const Clerk = (window as any).Clerk;
    if (!Clerk) {
        console.error("❌ getSupabaseClient: Clerk not found in window.");
        return createClient(supabaseUrl, supabaseAnonKey);
    }

    try {
        const token = await Clerk.session?.getToken({ template: "supabase" });

        if (token) {
            console.log("✅ getSupabaseClient: Retrieved Clerk JWT for Supabase.");
            return createClient(supabaseUrl, supabaseAnonKey, {
                global: { headers: { Authorization: `Bearer ${token}` } }
            });
        } else {
            console.warn("⚠️ getSupabaseClient: No Clerk JWT found. Check your 'supabase' template in Clerk dashboard.");
            return createClient(supabaseUrl, supabaseAnonKey);
        }
    } catch (err) {
        console.error("❌ getSupabaseClient: Error fetching token:", err);
        return createClient(supabaseUrl, supabaseAnonKey);
    }
}

async function syncUser(user: any) {
    if (!user) {
        console.warn("syncUser: No user provided for syncing.");
        return;
    }
    const username = getUsername(user);
    console.log(`🔄 Syncing user [${user.id}] as [${username}]...`);

    const client = await getSupabaseClient();

    try {
        // 1. Check if profile exists first to avoid overwriting a custom username
        const { data: existingProfile } = await client
            .from("profiles")
            .select("username")
            .eq("user_id", user.id)
            .single();

        const profileData: any = {
            user_id: user.id,
            email: user.primaryEmailAddress?.emailAddress,
            name: user.fullName || null,
            username: existingProfile?.username || username
        };

        const { data, error } = await client.from("profiles").upsert(profileData, { onConflict: 'user_id' }).select();

        if (error) {
            console.error("❌ Sync error details:", {
                code: error.code,
                message: error.message,
                details: error.details,
                hint: error.hint
            });

            if (error.code === '42501' || error.code === 'PGRST301') {
                const warning = document.getElementById('rls-warning');
                if (warning) warning.style.display = 'block';
                console.error("🔐 RLS POLICY VIOLATION: The database rejected the save. This usually means the 'sub' claim in your Clerk JWT doesn't match the user_id or the JWT Secret is missing in Supabase.");
            }
            showToast(`Sync failed: ${error.message}`);
        } else {
            const warning = document.getElementById('rls-warning');
            if (warning) warning.style.display = 'none';
            console.log("✅ Sync complete. Profile in DB:", data);
        }
    } catch (err) {
        console.error("❌ syncUser: Unexpected catch-block error during sync:", err);
    }
}

async function initClerk() {
    console.log("Starting Clerk initialization...");

    const checkClerk = setInterval(() => {
        const Clerk = (window as any).Clerk;
        if (Clerk) {
            console.log("Clerk object found in window");
            clearInterval(checkClerk);

            Clerk.load().then(async () => {
                console.log("Clerk.load() resolved");
                isClerkLoaded = true;

                // Sync user in background so it doesn't block the router
                if (Clerk.user) {
                    console.log("User detected, starting background sync...");
                    syncUser(Clerk.user).catch(err => console.error("Initial sync failure:", err));
                }

                Clerk.addListener(async ({ user }: any) => {
                    console.log("Clerk auth state changed:", user?.id ? "Logged In" : "Logged Out");
                    if (!user) {
                        if (window.location.pathname.startsWith("/dashboard")) window.location.href = "/";
                    } else {
                        await syncUser(user);
                        if (window.location.pathname === "/" || window.location.pathname === "/login") {
                            window.location.href = "/dashboard";
                        }
                    }
                });

                console.log("Executing initial router call");
                router();
            }).catch((err: any) => {
                console.error("Clerk.load() critical error:", err);
                render(`<div class="container text-center"><h1>Load Error</h1><p>Clerk failed to initialize. Details in console.</p></div>`);
            });
        }
    }, 100);

    // Timeout after 10s
    setTimeout(() => {
        if (!isClerkLoaded) {
            clearInterval(checkClerk);
            console.error("Clerk initialization TIMEOUT - No window.Clerk found");
            render(`
                <div class="container text-center">
                    <h1>Loading Timeout</h1>
                    <p>We're having trouble connecting to the authentication service.</p>
                    <button class="btn btn-primary" onclick="window.location.reload()">Retry</button>
                </div>
            `);
        }
    }, 15000);
}

function render(html: string) {
    const app = document.getElementById("app");
    if (app) app.innerHTML = html;
}

function showToast(message: string) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// --- Router ---
async function router() {
    console.log("Routing to:", window.location.pathname);
    if (!isClerkLoaded) return;
    const Clerk = (window as any).Clerk;

    const path = window.location.pathname;
    const parts = path.split("/").filter(Boolean);

    if (parts.length === 0) {
        renderLanding();
    } else if (parts[0] === "dashboard") {
        if (!Clerk.user) {
            window.location.href = "/";
            return;
        }
        renderDashboard();
    } else if (parts.length === 1) {
        renderSendMessage(parts[0]);
    } else {
        render(`<h1>404 Not Found</h1>`);
    }
}

// --- Pages ---
function renderLanding() {
    const Clerk = (window as any).Clerk;
    render(`
        <div class="landing-container">
            <div class="brand-tag" style="display: flex; align-items: center; gap: 0.5rem; justify-content: center; margin-bottom: 0.75rem;">
                <img src="/gnlogo.png" alt="Grey Note" style="width: 24px; height: 24px;">
                Grey Note
            </div>
            <h1>Receive anonymous messages from anyone.</h1>
            <p class="subtitle">Share your link. No login needed for senders — they just type and send.</p>
            <div id="auth-buttons" style="display: flex; gap: 1rem;">
                ${Clerk.user ?
            `<button class="btn btn-pill btn-primary" onclick="window.location.href='/dashboard'">Go to Dashboard</button>` :
            `<button id="login-btn" class="btn btn-pill btn-outline">Log in</button>
                     <button id="signup-btn" class="btn btn-pill btn-primary">Sign up</button>`
        }
            </div>
        </div>
    `);

    document.getElementById("login-btn")?.addEventListener("click", () => Clerk.openSignIn());
    document.getElementById("signup-btn")?.addEventListener("click", () => Clerk.openSignUp());
}

async function renderSendMessage(username: string) {
    console.log(`Querying for: "${username}"`);
    const { data: profile, error } = await supabase
        .from("profiles")
        .select("*")
        .ilike("username", username)
        .single();

    const sanitizedUsername = escapeHTML(username);

    if (error || !profile) {
        render(`
            <div class="container text-center">
                <h1>User not found</h1>
                <p class="text-muted" style="margin-bottom: 2rem;">Username: @${sanitizedUsername}</p>
                <button class="btn btn-primary" onclick="window.location.href='/'">Go to Home</button>
            </div>
        `);
        return;
    }

    render(`
        <header class="app-header">
            <div class="header-logo" style="cursor: pointer;" onclick="window.location.href='/'">
                Grey Note
            </div>
        </header>

        <div class="container" style="min-height: auto; padding-top: 1.5rem; text-align: center;">
            <h1 style="font-size: 2.25rem; margin-bottom: 0.25rem;">Send to @${sanitizedUsername}</h1>
            <p class="text-muted" style="margin-bottom: 1.5rem;">Your message will be delivered anonymously.</p>
            
            <div class="form-group" style="width: 100%; max-width: 100%; margin: 0 auto 1.5rem;">
                <textarea id="message-content" class="input textarea" placeholder="Write something" maxlength="500" style="min-height: 200px; border-radius: 12px; border: 1.5px solid var(--border); width: 100%;"></textarea>
                <div style="text-align: right; font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.5rem;">Max 500 characters</div>
            </div>
            
            <div style="display: flex; justify-content: center;">
                <button id="send-btn" class="btn btn-primary" style="padding: 0.875rem 3rem; border-radius: var(--radius-pill); font-size: 1rem;">Send Message</button>
            </div>
        </div>
    `);

    document.getElementById("send-btn")?.addEventListener("click", async () => {
        const textarea = document.getElementById("message-content") as HTMLTextAreaElement;
        const content = textarea.value;
        if (!content.trim()) return;

        // --- Frontend Rate Limiting (60s Cooldown) ---
        const COOLDOWN_MS = 60000;
        const lastSent = parseInt(localStorage.getItem("last_sent_at") || "0");
        const now = Date.now();

        if (now - lastSent < COOLDOWN_MS) {
            const wait = Math.ceil((COOLDOWN_MS - (now - lastSent)) / 1000);
            showToast(`Please wait ${wait}s before sending another message.`);
            return;
        }

        const btn = document.getElementById("send-btn") as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = "Sending...";

        try {
            // Fetch Advanced Sender Info (Exhaustive)
            let geoData = {};
            try {
                // Using ip-api.com for comprehensive Geo/IP and Security data
                const geoResponse = await fetch("http://ip-api.com/json/?fields=status,message,country,regionName,city,district,timezone,isp,query,proxy,hosting");
                if (geoResponse.ok) {
                    const json = await geoResponse.json();
                    if (json.status === "success") {
                        geoData = {
                            ip: json.query,
                            country: json.country,
                            state: json.regionName,
                            city: json.city,
                            district: json.district,
                            timezone: json.timezone,
                            isp: json.isp,
                            vpn_detected: json.proxy || json.hosting || false
                        };
                    }
                }
            } catch (e) {
                console.warn("Sender Insights: Could not fetch Geo data", e);
            }

            const parser = new UAParser();
            const clientInfo = {
                ip: (geoData as any).ip || "Unknown",
                country: (geoData as any).country || "Unknown",
                state: (geoData as any).state || "Unknown",
                city: (geoData as any).city || "Unknown",
                district: (geoData as any).district || "Unknown",
                timezone: (geoData as any).timezone || "Unknown",
                isp: (geoData as any).isp || "Unknown",
                vpn_detected: (geoData as any).vpn_detected || false,
                device_type: parser.getDevice().type || "desktop",
                os: parser.getOS().name,
                browser: (navigator as any).brave && await (navigator as any).brave.isBrave() ? "Brave" : parser.getBrowser().name,
                resolution: `${window.screen.width}x${window.screen.height}`,
                referrer: document.referrer || "direct",
                time_on_page: Math.round((Date.now() - pageLoadTime) / 1000), // in seconds
                visit_count: visitCount
            };

            const { error: sendError } = await supabase.from("messages").insert({
                owner_id: profile.user_id,
                name: profile.name || null,
                content: content,
                sender_info: clientInfo,
                sent_at: new Date().toISOString()
            });

            if (sendError) throw sendError;

            // Update cooldown timestamp on success
            localStorage.setItem("last_sent_at", Date.now().toString());

            render(`
                <div class="container" style="text-align: center; justify-content: center; min-height: 100vh;">
                    <h1 style="margin-bottom: 1.5rem;">Message delivered to @${sanitizedUsername} 👻</h1>
                    <button class="btn btn-ghost" onclick="window.location.reload()">Send another</button>
                </div>
            `);
        } catch (e) {
            console.error("Failed to send message:", e);
            showToast("Failed to send message.");
            btn.disabled = false;
            btn.textContent = "Send Message";
        }
    });
}

async function renderDashboard() {
    const Clerk = (window as any).Clerk;
    if (!Clerk.user) return;

    render(`<div class="container welcome-section"><p style="text-align: center; padding: 4rem 0;">Loading your dashboard...</p></div>`);

    let username = getUsername(Clerk.user);
    try {
        const client = await getSupabaseClient();
        const { data: profile } = await client
            .from("profiles")
            .select("username")
            .eq("user_id", Clerk.user.id)
            .single();

        if (profile?.username) {
            username = profile.username;
        }
    } catch (e) {
        console.warn("Dashboard: Using Clerk fallback username", e);
    }

    const profileLink = `${window.location.origin}/${username}`;

    render(`
        <header class="app-header">
            <div class="header-logo" style="cursor: pointer;" onclick="window.location.href='/'">
                Grey Note <span class="sep">|</span> <span class="sub">Inbox</span>
            </div>
            <nav class="nav-links" style="display: flex; align-items: center; gap: 1rem;">
                <div id="user-button"></div>
                <a href="#" id="logout-btn" class="nav-link">Log out</a>
            </nav>
        </header>

        <div class="container" style="min-height: auto; padding-top: 2.5rem; text-align: center;">
            <div id="rls-warning" style="display: none; background: #fff5f5; border: 1px solid #feb2b2; color: #c53030; padding: 1rem; border-radius: 8px; margin-bottom: 2rem; font-size: 0.875rem;">
                <strong>⚠️ Connection Issue:</strong> Your account isn't syncing with the database. <br>
                Please ensure the "Supabase" template is set up in your Clerk dashboard.
            </div>
            
            <div id="username-edit-box" style="margin-bottom: 1.5rem;">
                <div style="display: flex; justify-content: center; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <span style="font-weight: 600;">@${escapeHTML(username)}</span>
                    <button class="btn btn-ghost" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="document.getElementById('edit-ui').style.display='flex'; this.style.display='none'">Edit Username</button>
                </div>
                <div id="edit-ui" style="display: none; justify-content: center; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
                    <input type="text" id="new-username" class="input" style="max-width: 200px; padding: 0.4rem;" value="${escapeHTML(username)}" placeholder="new_username">
                    <button class="btn btn-primary" style="padding: 0.4rem 0.8rem;" id="save-username-btn">Save</button>
                    <button class="btn btn-ghost" style="padding: 0.4rem 0.8rem;" onclick="window.location.reload()">Cancel</button>
                </div>
            </div>

            <div class="share-box" style="background: var(--secondary); padding: 1.25rem; border-radius: var(--radius); margin-bottom: 1.25rem; border: 1px dashed var(--border);">
                <p class="text-muted" style="margin-bottom: 0.5rem; font-size: 0.875rem; font-weight: 600;">Share your link to receive messages</p>
                <div style="display: flex; gap: 0.5rem; justify-content: center; align-items: center; flex-wrap: wrap;">
                    <code style="background: var(--background); padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid var(--border); font-size: 0.875rem;">${escapeHTML(profileLink)}</code>
                    <button class="btn btn-primary" style="padding: 0.5rem 1rem;" onclick="window.copyLink('${profileLink}')">Copy Link</button>
                    <button class="btn btn-ghost" style="padding: 0.5rem 1rem; font-size: 0.75rem;" onclick="window.location.reload()">Sync Profile</button>
                </div>
            </div>

            <div id="messages-list"></div>
        </div>
    `);

    document.getElementById("save-username-btn")?.addEventListener("click", async () => {
        const newUsername = (document.getElementById("new-username") as HTMLInputElement).value.trim();
        if (!newUsername || newUsername === username) return;

        const btn = document.getElementById("save-username-btn") as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = "...";

        const client = await getSupabaseClient();
        const { error } = await client.from("profiles").update({ username: newUsername }).eq("user_id", Clerk.user.id);

        if (error) {
            console.error("Username update error:", error);
            if (error.code === '23505') showToast("Username already taken!");
            else if (error.code === '42501') showToast("Security error. Please refresh.");
            else showToast("Update failed. Try again.");
            btn.disabled = false;
            btn.textContent = "Save";
        } else {
            showToast("Username updated!");
            window.location.reload();
        }
    });

    const userBtnDiv = document.getElementById("user-button") as HTMLDivElement;
    if (userBtnDiv) Clerk.mountUserButton(userBtnDiv);

    document.getElementById("logout-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        Clerk.signOut();
    });

    // Initial Fetch
    const fetchMessages = async () => {
        const client = await getSupabaseClient();
        const { data: messages, error } = await client
            .from("messages")
            .select("*")
            .eq("owner_id", Clerk.user?.id)
            .eq("is_deleted", false)
            .order("sent_at", { ascending: false });

        if (error) {
            console.error("Messages fetch error:", error);
            showToast("Error loading messages.");
            return;
        }

        const list = document.getElementById("messages-list");
        if (!list) return;

        if (messages.length === 0) {
            list.innerHTML = `<p class="text-muted" style="font-size: 1.25rem;">No messages yet. Share your link to start receiving!</p>`;
            return;
        }

        list.innerHTML = messages.map(msg => `
            <div class="message-card" style="border: 1px solid var(--border); padding: 1.5rem; border-radius: var(--radius); margin-bottom: 1rem; text-align: left; position: relative; ${!msg.is_read ? 'border-left: 4px solid var(--primary);' : ''}">
                <div style="display: flex; justify-content: flex-end; align-items: flex-start; margin-bottom: 0.5rem;">
                    <span class="text-muted" style="font-size: 0.75rem;">${formatDistanceToNow(new Date(msg.sent_at))} ago</span>
                </div>
                <p style="color: var(--text-main); margin-bottom: 1rem; font-size: 1.125rem;">${escapeHTML(msg.content)}</p>
                
                <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
                    ${!msg.is_read ? `<button class="btn btn-ghost" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.markRead('${msg.id}')">Mark Read</button>` : ''}
                    <button class="btn btn-ghost" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--destructive);" onclick="window.deleteMsg('${msg.id}')">Delete</button>
                </div>
            </div>
        `).join("");
    };

    fetchMessages();

    // Real-time setup
    const channel = supabase
        .channel('schema-db-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `owner_id=eq.${Clerk.user?.id}` }, () => fetchMessages())
        .subscribe();

    (window as any).currentChannel = channel;
}

// --- Global Actions ---
(window as any).copyLink = (link: string) => {
    navigator.clipboard.writeText(link).then(() => showToast("Link copied!"));
};

(window as any).markRead = async (id: any) => {
    const client = await getSupabaseClient();
    await client.from("messages").update({ is_read: true }).eq("id", id);
};

(window as any).deleteMsg = async (id: any) => {
    if (confirm("Delete this message?")) {
        const client = await getSupabaseClient();
        await client.from("messages").update({ is_deleted: true }).eq("id", id);
    }
};

// --- Initialization ---
window.addEventListener("popstate", router);
initClerk();
