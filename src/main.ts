import { createClient } from "@supabase/supabase-js";
import { UAParser } from "ua-parser-js";
import { formatDistanceToNow } from "date-fns";

// --- Supabase Config ---
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Single Supabase client with custom fetch that automatically injects Clerk's JWT for authenticated requests.
// PersistSession is disabled because Clerk manages all auth sessions in the browser.
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    },
    global: {
        fetch: async (url, options: any = {}) => {
            const Clerk = (window as any).Clerk;
            if (Clerk?.session) {
                try {
                    const token = await Clerk.session.getToken({ template: "supabase" });
                    if (token) {
                        const headers = new Headers(options.headers || {});
                        headers.set("Authorization", `Bearer ${token}`);
                        options.headers = headers;
                    }
                } catch (e) {
                    console.warn("Clerk token for Supabase fetch warning:", e);
                }
            }
            return fetch(url, options);
        }
    }
});

async function getSupabaseClient() {
    return supabase;
}

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
    if (user.username) return user.username.toLowerCase();
    const firstName = user.firstName || "";
    const lastName = user.lastName || "";
    if (firstName || lastName) {
        return (firstName + lastName).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    }
    return (user.externalAccounts?.[0]?.username || user.id.slice(-8)).toLowerCase();
}

async function fetchUserLocation() {
    const apis = [
        "https://ipapi.co/json/",
        "https://ipwho.is/",
        "https://api.db-ip.com/v2/free/self"
    ];

    for (const url of apis) {
        try {
            console.log(`Sync User: Fetching location from ${url}...`);
            const response = await fetch(url);
            if (response.ok) {
                const json = await response.json();
                if (!json.error) {
                    // Normalize response formats
                    return {
                        ip: json.ip || json.query || json.ipAddress,
                        country: json.country_name || json.country || json.countryName,
                        state: json.region || json.region_name || json.stateProv,
                        city: json.city,
                        timezone: json.timezone || json.time_zone?.name,
                        isp: json.org || json.connection?.isp || json.clientName,
                        source: url
                    };
                }
            }
        } catch (e) {
            console.warn(`Sync User: Could not fetch location from ${url}`, e);
        }
    }
    return null;
}

async function syncUser(user: any, force = false) {
    if (!user) {
        console.warn("syncUser: No user provided for syncing.");
        return;
    }

    // Avoid redundant DB writes on every page load/interaction if already synced this session
    const sessionSyncKey = `synced_user_${user.id}`;
    if (!force && sessionStorage.getItem(sessionSyncKey)) {
        console.log(`⚡ syncUser: User [${user.id}] already synced in this session. Skipping DB write.`);
        return;
    }

    const username = getUsername(user);
    console.log(`🔄 Syncing user [${user.id}] as [${username}]...`);

    const client = await getSupabaseClient();
    const location = await fetchUserLocation();

    try {
        // 1. Check if profile exists first to avoid overwriting a custom username
        const { data: existingProfile } = await client
            .from("profiles")
            .select("username")
            .eq("user_id", user.id)
            .maybeSingle();

        const profileData: any = {
            user_id: user.id,
            email: user.primaryEmailAddress?.emailAddress,
            name: user.fullName || null,
            username: (existingProfile?.username || username).toLowerCase(),
            location: location
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
            sessionStorage.setItem(sessionSyncKey, "true");
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

    // Clean up realtime channel when not on dashboard
    if (parts[0] !== "dashboard" && (window as any).currentChannel) {
        supabase.removeChannel((window as any).currentChannel);
        (window as any).currentChannel = null;
    }

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
    const rawUsername = username.trim();
    const normalizedUsername = rawUsername.toLowerCase();
    console.log(`Querying for: "${normalizedUsername}"`);

    // 1. Try fast exact match on indexed lowercase username, avoiding heavy fields like location
    let { data: profile, error } = await supabase
        .from("profiles")
        .select("user_id, username, name")
        .eq("username", normalizedUsername)
        .maybeSingle();

    // 2. Fallback to ilike only if not found (for backwards compatibility with legacy mixed-case usernames)
    if (!profile) {
        const fallback = await supabase
            .from("profiles")
            .select("user_id, username, name")
            .ilike("username", rawUsername)
            .maybeSingle();
        profile = fallback.data;
        error = fallback.error;
    }

    const sanitizedUsername = escapeHTML(profile?.username || rawUsername);

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

    const Clerk = (window as any).Clerk;
    const isLoggedIn = !!Clerk?.user;

    render(`
        <header class="app-header">
            <div class="header-logo" style="cursor: pointer;" onclick="window.location.href='/'">
                <img src="/gnlogo.png" alt="Grey Note" class="logo-img" style="width: 28px; height: 28px; border-radius: 6px;">
                <span class="logo-text">Grey Note</span>
            </div>
        </header>

        <div class="container" style="min-height: auto; padding-top: 1.5rem; text-align: center;">
            <h1 style="font-size: clamp(1.4rem, 4vw, 2rem); margin-bottom: 0.25rem;">Send to @${sanitizedUsername}</h1>
            <p class="text-muted" style="margin-bottom: 1.5rem; font-size: 0.875rem;">Your message will be delivered anonymously.</p>
            
            <div class="form-group" style="width: 100%; max-width: 100%; margin: 0 auto 1.5rem;">
                <textarea id="message-content" class="input textarea" placeholder="Write something..." maxlength="500" rows="3" style="min-height: 80px; max-height: 320px; overflow-y: auto; resize: none; border-radius: 12px; border: 1.5px solid var(--border); width: 100%; padding: 0.875rem 1rem; font-size: 1rem; line-height: 1.5; box-sizing: border-box;"></textarea>
                <div style="text-align: right; font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.5rem;">Max 500 characters</div>
            </div>
            
            <div style="display: flex; flex-direction: column; align-items: center; gap: 1.25rem;">
                <button id="send-btn" class="btn btn-primary" style="padding: 0.875rem 3rem; border-radius: var(--radius-pill); font-size: 1rem;">Send Message</button>
                <a href="${isLoggedIn ? '/dashboard' : '/'}" style="font-size: 0.875rem; color: var(--muted); text-decoration: none; transition: all 0.2s; display: flex; align-items: center; gap: 0.5rem;" onmouseover="this.style.color='var(--primary)'; this.style.transform='translateY(-1px)'" onmouseout="this.style.color='var(--muted)'; this.style.transform='translateY(0)'">
                    ${isLoggedIn ? '← Back to your dashboard' : 'New here? Create your own anonymous link 👻'}
                </a>
            </div>
        </div>
    `);

    // Auto-expand textarea to fit message length
    const msgTextarea = document.getElementById("message-content") as HTMLTextAreaElement;
    if (msgTextarea) {
        msgTextarea.addEventListener("input", function() {
            this.style.height = "auto";
            this.style.height = Math.min(this.scrollHeight, 320) + "px";
        });
    }

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
            console.log("Sender Insights: Fetching Geo data...");
            const geoData = await fetchUserLocation() || {};
            console.log("Sender Insights: Received Geo data", geoData);


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
                <header class="app-header">
                    <div class="header-logo" style="cursor: pointer;" onclick="window.location.href='/'">
                        <img src="/gnlogo.png" alt="Grey Note" class="logo-img" style="width: 28px; height: 28px; border-radius: 6px;">
                        <span class="logo-text">Grey Note</span>
                    </div>
                </header>

                <div class="container" style="text-align: center; justify-content: center; min-height: calc(100vh - 100px); padding-top: 1.5rem;">
                    <div style="font-size: 3.5rem; margin-bottom: 0.75rem;">👻</div>
                    <h1 style="font-size: clamp(1.35rem, 5vw, 1.875rem); line-height: 1.3; margin-bottom: 1.5rem; max-width: 360px; margin-left: auto; margin-right: auto;">
                        Message delivered to <br><span style="color: var(--primary);">@${sanitizedUsername}</span>
                    </h1>

                    <div style="display: flex; flex-direction: column; align-items: center; gap: 0.75rem; width: 100%; max-width: 280px; margin: 0 auto;">
                        ${isLoggedIn ? `
                            <a href="/dashboard" class="btn btn-primary" style="width: 100%; padding: 0.75rem 1.5rem; border-radius: var(--radius-pill); font-size: 0.9375rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;">
                                ← Back to My Dashboard
                            </a>
                        ` : `
                            <button class="btn btn-primary" onclick="window.history.length > 1 ? window.history.back() : window.location.href='/'" style="width: 100%; padding: 0.75rem 1.5rem; border-radius: var(--radius-pill); font-size: 0.9375rem; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;">
                                ← Go Back
                            </button>
                        `}
                        <button class="btn btn-outline" style="width: 100%; padding: 0.625rem 1.25rem; border-radius: var(--radius-pill); font-size: 0.875rem;" onclick="window.location.reload()">
                            ✍️ Send Another Note
                        </button>
                        <a href="${isLoggedIn ? '/dashboard' : '/'}" style="font-size: 0.8125rem; color: var(--muted); text-decoration: none; margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem;">
                            ${isLoggedIn ? 'Go to your inbox & messages ➔' : 'New here? Create your own anonymous link 👻'}
                        </a>
                    </div>
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
    const initials = ((Clerk.user.firstName?.[0] || "") + (Clerk.user.lastName?.[0] || "")).toUpperCase() || username.slice(0, 2).toUpperCase();

    render(`
        <header class="app-header">
            <div class="header-logo" style="cursor: pointer;" onclick="window.location.href='/'">
                <img src="/gnlogo.png" alt="Grey Note" class="logo-img" style="width: 28px; height: 28px; border-radius: 6px;">
                <span class="logo-text">Grey Note</span> <span class="sep">|</span> <span class="sub">Inbox</span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
                <div id="user-button"></div>
                <a href="#" id="logout-btn" class="nav-link" style="font-size: 0.8125rem;">Log out</a>
            </div>
        </header>

        <div class="container" style="min-height: auto; padding-top: 1.5rem; text-align: center;">
            <div id="rls-warning" style="display: none; background: #fff5f5; border: 1px solid #feb2b2; color: #c53030; padding: 0.875rem 1rem; border-radius: 8px; margin-bottom: 1.25rem; font-size: 0.875rem; text-align: left;">
                <strong>⚠️ Connection Issue:</strong> Your account isn't syncing with the database. <br>
                Please ensure the "Supabase" template is set up in your Clerk dashboard.
            </div>
            
            <!-- Ultra-Compact Profile & Share Card -->
            <div class="profile-card">
                <div class="profile-header-row">
                    <div class="profile-clickable-area" id="profile-toggle-link" title="Tap to view & share your link">
                        <div class="user-avatar-badge">${escapeHTML(initials)}</div>
                        <div class="user-handle">
                            @${escapeHTML(username)}
                            <span class="link-toggle-badge" id="link-toggle-badge">🔗 My Link ▾</span>
                        </div>
                    </div>
                    <div class="profile-actions">
                        <button class="icon-btn" id="edit-username-toggle" title="Edit Username">
                            ✏️ Edit
                        </button>
                    </div>
                </div>

                <!-- Hidden Inline Edit UI -->
                <div id="edit-ui" style="display: none; align-items: center; gap: 0.5rem; margin-top: 0.75rem; background: var(--secondary); padding: 0.625rem; border-radius: 0.5rem;">
                    <input type="text" id="new-username" class="input" style="flex: 1; padding: 0.45rem 0.65rem; font-size: 0.875rem;" value="${escapeHTML(username)}" placeholder="new_username">
                    <button class="btn btn-primary" style="padding: 0.45rem 0.875rem; font-size: 0.8125rem;" id="save-username-btn">Save</button>
                    <button class="btn btn-ghost" style="padding: 0.45rem 0.65rem; font-size: 0.8125rem;" id="cancel-edit-btn">Cancel</button>
                </div>

                <!-- Collapsible Link Drawer: Hidden by default, expands when clicking profile -->
                <div id="profile-link-drawer" class="profile-link-drawer" style="display: none;">
                    <!-- Tap-to-Copy Link Pill -->
                    <div class="share-link-pill" onclick="window.copyLink('${profileLink}')" title="Click to copy your link">
                        <span class="share-link-text">${escapeHTML(profileLink)}</span>
                        <span class="copy-badge">📋 Copy</span>
                    </div>

                    <div class="share-btn-group">
                        <button class="btn btn-primary" onclick="window.copyLink('${profileLink}')">
                            📋 Copy Link
                        </button>
                        <button class="btn btn-outline" onclick="window.shareLink('${profileLink}', '${escapeHTML(username)}')">
                            🔗 Share Link
                        </button>
                    </div>
                </div>
            </div>

            <!-- Ultra-Compact Direct Note Bar (Zero Extra Lines) -->
            <div class="search-card">
                <div class="search-input-wrap">
                    <div class="search-input-box">
                        <span class="prefix-icon">💌</span>
                        <input type="text" id="search-user-input" class="search-input" placeholder="Send note to @username or link..." autocomplete="off">
                    </div>
                    <button id="search-user-btn" class="btn btn-primary search-action-btn">
                        Send ➔
                    </button>
                </div>
            </div>

            <!-- Messages Inbox Header -->
            <div class="inbox-header-row">
                <h2 class="inbox-title">Your Messages</h2>
                <span id="messages-count" class="inbox-badge">...</span>
            </div>

            <div id="messages-list"></div>
        </div>
    `);

    // Toggle profile link drawer on profile click
    document.getElementById("profile-toggle-link")?.addEventListener("click", () => {
        const drawer = document.getElementById("profile-link-drawer");
        const badge = document.getElementById("link-toggle-badge");
        if (!drawer) return;
        const isHidden = drawer.style.display === "none";
        drawer.style.display = isHidden ? "block" : "none";
        if (badge) {
            badge.textContent = isHidden ? "🔗 My Link ▴" : "🔗 My Link ▾";
            badge.classList.toggle("active", isHidden);
        }
    });

    // Toggle edit username UI
    document.getElementById("edit-username-toggle")?.addEventListener("click", () => {
        const editUi = document.getElementById("edit-ui");
        if (editUi) {
            const isHidden = editUi.style.display === "none";
            editUi.style.display = isHidden ? "flex" : "none";
            if (isHidden) {
                (document.getElementById("new-username") as HTMLInputElement)?.focus();
            }
        }
    });

    document.getElementById("cancel-edit-btn")?.addEventListener("click", () => {
        const editUi = document.getElementById("edit-ui");
        if (editUi) editUi.style.display = "none";
    });

    // Save username handler
    document.getElementById("save-username-btn")?.addEventListener("click", async () => {
        const inputUsername = (document.getElementById("new-username") as HTMLInputElement).value.trim();
        const newUsername = inputUsername.toLowerCase();
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
            sessionStorage.removeItem(`synced_user_${Clerk.user.id}`);
            showToast("Username updated!");
            window.location.reload();
        }
    });

    // Search and send navigation handler
    const extractUsername = (input: string): string => {
        let val = input.trim();
        if (!val) return "";
        if (val.includes("/") || val.includes(".")) {
            try {
                const urlStr = val.startsWith("http://") || val.startsWith("https://") ? val : `https://${val}`;
                const url = new URL(urlStr);
                const segments = url.pathname.split("/").filter(Boolean);
                if (segments.length > 0) {
                    val = segments[segments.length - 1];
                }
            } catch {
                const parts = val.split("/").filter(Boolean);
                if (parts.length > 0) val = parts[parts.length - 1];
            }
        }
        return val.replace(/^@+/, "").split("?")[0].split("#")[0].trim().toLowerCase();
    };

    const handleSearchNavigate = () => {
        const searchInput = document.getElementById("search-user-input") as HTMLInputElement;
        if (!searchInput) return;
        const target = extractUsername(searchInput.value);
        if (!target) {
            showToast("Please enter a username or paste a link.");
            searchInput.focus();
            return;
        }
        if (target === username.toLowerCase()) {
            showToast("That's your own link! Enter someone else's link or username.");
            return;
        }
        window.location.href = `/${target}`;
    };

    document.getElementById("search-user-btn")?.addEventListener("click", handleSearchNavigate);
    document.getElementById("search-user-input")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleSearchNavigate();
        }
    });

    const userBtnDiv = document.getElementById("user-button") as HTMLDivElement;
    if (userBtnDiv) Clerk.mountUserButton(userBtnDiv);

    document.getElementById("logout-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        Clerk.signOut();
    });

    // Initial Fetch (select only display columns, avoid heavy TOAST sender_info, and limit rows)
    const fetchMessages = async () => {
        const client = await getSupabaseClient();
        const { data: messages, error } = await client
            .from("messages")
            .select("id, content, sent_at, is_read")
            .eq("owner_id", Clerk.user?.id)
            .eq("is_deleted", false)
            .order("sent_at", { ascending: false })
            .limit(50);

        if (error) {
            console.error("Messages fetch error:", error);
            showToast("Error loading messages.");
            return;
        }

        const countBadge = document.getElementById("messages-count");
        if (countBadge && messages) {
            const unread = messages.filter(m => !m.is_read).length;
            countBadge.textContent = messages.length === 0 ? "0 notes" : `${messages.length} notes${unread > 0 ? ` (${unread} new)` : ''}`;
        }

        const list = document.getElementById("messages-list");
        if (!list) return;

        if (messages.length === 0) {
            list.innerHTML = `<p class="text-muted" style="font-size: 1.125rem; padding: 2rem 0;">No messages yet. Share your link to start receiving!</p>`;
            return;
        }

        list.innerHTML = messages.map(msg => `
            <div class="message-card" style="border: 1px solid var(--border); padding: 0.875rem 1rem; border-radius: 0.75rem; margin-bottom: 0.625rem; text-align: left; background: #ffffff; ${!msg.is_read ? 'border-left: 3.5px solid var(--primary);' : ''}">
                <p style="color: var(--foreground); margin: 0 0 0.5rem 0; font-size: 0.95rem; line-height: 1.45; word-break: break-word; white-space: pre-wrap;">${escapeHTML(msg.content)}</p>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f1f5f9; padding-top: 0.35rem; margin-top: 0.25rem;">
                    <span class="text-muted" style="font-size: 0.6875rem;">${formatDistanceToNow(new Date(msg.sent_at))} ago</span>
                    <div style="display: flex; gap: 0.5rem;">
                        ${!msg.is_read ? `<button class="btn btn-ghost" style="font-size: 0.6875rem; padding: 0.15rem 0.4rem; height: auto;" onclick="window.markRead('${msg.id}')">Mark Read</button>` : ''}
                        <button class="btn btn-ghost" style="font-size: 0.6875rem; padding: 0.15rem 0.4rem; height: auto; color: var(--destructive);" onclick="window.deleteMsg('${msg.id}')">Delete</button>
                    </div>
                </div>
            </div>
        `).join("");
    };

    fetchMessages();

    // Clean up existing Realtime channel to prevent multiple duplicate subscriptions & fetches
    if ((window as any).currentChannel) {
        supabase.removeChannel((window as any).currentChannel);
        (window as any).currentChannel = null;
    }

    // Real-time setup
    const channel = supabase
        .channel(`messages-${Clerk.user?.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `owner_id=eq.${Clerk.user?.id}` }, () => fetchMessages())
        .subscribe();

    (window as any).currentChannel = channel;
}

// --- Global Actions ---
(window as any).copyLink = (link: string) => {
    navigator.clipboard.writeText(link).then(() => showToast("Link copied to clipboard! 📋"));
};

(window as any).shareLink = async (link: string, uname: string) => {
    if (navigator.share) {
        try {
            await navigator.share({
                title: `Send an anonymous note to @${uname}`,
                text: `Send me an anonymous note on Grey Note! 👻`,
                url: link
            });
            return;
        } catch {
            return;
        }
    }
    (window as any).copyLink(link);
};

(window as any).markRead = async (id: any) => {
    const client = await getSupabaseClient();
    await client.from("messages").update({ is_read: true }).eq("id", id);
};

(window as any).syncProfile = async () => {
    const Clerk = (window as any).Clerk;
    if (Clerk?.user) {
        sessionStorage.removeItem(`synced_user_${Clerk.user.id}`);
        await syncUser(Clerk.user, true);
        window.location.reload();
    }
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
