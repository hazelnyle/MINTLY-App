
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const configured =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("YOUR-PROJECT") &&
  SUPABASE_ANON_KEY.length > 30 &&
  !SUPABASE_ANON_KEY.includes("YOUR_");

const $ = id => document.getElementById(id);

const CURRENCIES = {
  USD: "US Dollar",
  PKR: "Pakistani Rupee",
  GBP: "British Pound",
  EUR: "Euro",
  AED: "UAE Dirham",
  ZAR: "South African Rand"
};

const RATE_CACHE_KEY = "mintly-exchange-rates-v2";
const RATE_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;

let currentCurrency = "USD";
let currentRates = { USD: 1 };
let currentRateDate = null;

let supabase = null;
let user = null;
let spaces = [];
let activeSpace = null;
let transactions = [];
let essentials = [];
let mode = "login";
let startingUserId = null;

const pendingKey = () => `mintly-pending-${user?.id || "guest"}`;

function message(text, type = "") {
  $("toast").textContent = text;
  $("toast").className = "small " + type;
}

function sync(text, warn = false) {
  $("syncState").textContent = text;
  $("syncState").style.color = warn ? "#a36b22" : "#718078";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

// EXCHANGE RATES

function readRateCache() {
  try {
    return JSON.parse(localStorage.getItem(RATE_CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveRateCache(snapshot) {
  try {
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    console.warn("Could not cache exchange rates:", e);
  }
}

function hasUsableRates(rates) {
  return !!rates &&
    Object.keys(CURRENCIES).every(code =>
      Number.isFinite(Number(rates[code])) && Number(rates[code]) > 0
    );
}

async function loadRates(force = false) {
  const cached = readRateCache();

  if (
    !force &&
    hasUsableRates(cached?.rates) &&
    cached.savedAt &&
    Date.now() - cached.savedAt < RATE_CACHE_MAX_AGE
  ) {
    currentRates = cached.rates;
    currentRateDate = cached.date || null;
    return;
  }

  if (!navigator.onLine) {
    if (hasUsableRates(cached?.rates)) {
      currentRates = cached.rates;
      currentRateDate = cached.date || null;
      return;
    }
    throw new Error("You're offline and no complete exchange-rate table is saved yet. Connect once to load currencies.");
  }

  const sources = [
    async () => {
      const response = await fetch("https://open.er-api.com/v6/latest/USD", {
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Primary rate service returned HTTP " + response.status);
      const result = await response.json();
      if (result.result !== "success" || result.base_code !== "USD") {
        throw new Error("Primary rate service returned an invalid response");
      }
      return {
        rates: result.rates,
        date: result.time_last_update_utc || null
      };
    },
    async () => {
      const urls = [
        "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
        "https://latest.currency-api.pages.dev/v1/currencies/usd.json"
      ];
      let lastError;
      for (const url of urls) {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) throw new Error("Backup rate service returned HTTP " + response.status);
          const result = await response.json();
          if (!result.usd || typeof result.usd !== "object") {
            throw new Error("Backup rate service returned an invalid response");
          }
          const rates = Object.fromEntries(
            Object.entries(result.usd).map(([code, rate]) => [code.toUpperCase(), rate])
          );
          return { rates, date: result.date || null };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Backup rate services are unavailable");
    }
  ];

  let lastError = null;

  for (const getRates of sources) {
    try {
      const result = await getRates();
      const rates = { ...result.rates, USD: 1 };

      if (!hasUsableRates(rates)) {
        throw new Error("Rate source did not provide every MINTLY currency");
      }

      currentRates = rates;
      currentRateDate = result.date;

      saveRateCache({
        base: "USD",
        rates: currentRates,
        date: currentRateDate,
        savedAt: Date.now()
      });

      return;
    } catch (error) {
      lastError = error;
      console.warn("MINTLY exchange-rate source failed:", error);
    }
  }

  if (hasUsableRates(cached?.rates)) {
    currentRates = cached.rates;
    currentRateDate = cached.date || null;
    console.warn("Using previously cached exchange rates.");
    return;
  }

  currentRates = { USD: 1 };
  currentRateDate = null;
  throw new Error(
    "MINTLY couldn't download exchange rates. Please check your connection and try again. " +
    (lastError?.message || "")
  );
}

function getSnapshot() {
  return {
    base: "USD",
    rates: { ...currentRates },
    date: currentRateDate
  };
}

function ratesFromSnapshot(snapshot) {
  if (!snapshot) return currentRates;

  if (snapshot.rates) return snapshot.rates;

  return snapshot;
}

function convertAmount(amount, from, to, snapshot = null) {
  const value = Number(amount || 0);

  if (from === to) return value;

  const rates = ratesFromSnapshot(snapshot);
  const fromRate = Number(rates?.[from]);
  const toRate = Number(rates?.[to]);

  if (
    !Number.isFinite(fromRate) ||
    !Number.isFinite(toRate) ||
    fromRate <= 0 ||
    toRate <= 0
  ) {
    return null;
  }

  return (value / fromRate) * toRate;
}

function formatMoney(amount, currency = currentCurrency, snapshot = null) {
  const converted = convertAmount(
    amount,
    currency,
    currentCurrency,
    snapshot
  );

  if (converted === null) {
    return `${Number(amount || 0).toFixed(2)} ${currency}`;
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currentCurrency
  }).format(converted);
}

function formatOriginalMoney(amount, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency
  }).format(Number(amount || 0));
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function getDueStatus(item) {
  if (!item.last_purchased) return { label: "Add last purchased date", overdue: false };
  const purchased = new Date(item.last_purchased + "T00:00:00");
  if (Number.isNaN(purchased.getTime())) return { label: "Due date unavailable", overdue: false };
  const due = new Date(purchased);
  due.setDate(due.getDate() + Math.max(1, Number(item.restock_days) || 30));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { label: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`, overdue: true };
  if (days === 0) return { label: "Due today", overdue: true };
  return { label: `Due in ${days} day${days === 1 ? "" : "s"}`, overdue: false };
}

// CURRENCY SELECTORS

function styleCurrencyControls() {
  if ($("mintlyCurrencyStyles")) return;

  const style = document.createElement("style");
  style.id = "mintlyCurrencyStyles";
  style.textContent = `
    .mintly-currency-field {
      display: block;
      margin: 8px 0;
      color: inherit;
      font-size: 13px;
    }
    .mintly-currency-field select {
      display: block;
      width: 100%;
      max-width: 180px;
      margin-top: 5px;
      padding: 9px;
      border: 1px solid #dce5df;
      border-radius: 9px;
      background: white;
      color: #294b3b;
    }
    #currencySelect {
      width: auto;
      max-width: 105px;
      padding: 9px 5px;
      border: 1px solid #dce5df;
      border-radius: 9px;
      background: white;
      color: #294b3b;
      font-size: 13px;
    }
    #mintlyRateAttribution {
      margin: 5px 0 12px;
      color: #718078;
      font-size: 10px;
    }
    #mintlyRateAttribution a {
      color: inherit;
      text-decoration: underline;
    }
  `;
  document.head.appendChild(style);
}

function makeCurrencySelect(id, selected = "USD") {
  const select = document.createElement("select");
  select.id = id;

  Object.entries(CURRENCIES).forEach(([code, name]) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = `${code} · ${name}`;
    select.appendChild(option);
  });

  select.value = CURRENCIES[selected] ? selected : "USD";
  return select;
}

function installCurrencySelectors() {
  styleCurrencyControls();

  // Personal display currency
  let display = $("currencySelect");

  if (!display) {
    const spaceSelect = $("spaceSelect");

    if (spaceSelect) {
      display = makeCurrencySelect("currencySelect", currentCurrency);
      display.title = "Your personal display currency";
      spaceSelect.insertAdjacentElement("afterend", display);
    }
  }

  if (display) {
    display.value = currentCurrency;

    if (!$("mintlyRateAttribution")) {
      const attribution = document.createElement("div");
      attribution.id = "mintlyRateAttribution";
      attribution.innerHTML = 'Exchange rates by <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">ExchangeRate-API</a>';
      display.insertAdjacentElement("afterend", attribution);
    }

    display.onchange = async () => {
      const selected = display.value;
      if (!CURRENCIES[selected] || !user) return;

      const previous = currentCurrency;
      display.disabled = true;

      try {
        const { data, error } = await supabase.auth.updateUser({
          data: { currency: selected }
        });

        if (error) throw error;

        currentCurrency = selected;
        user = data.user || user;
        render();

        message(`Display currency saved: ${selected}`);
      } catch (e) {
        currentCurrency = previous;
        display.value = previous;
        message("Currency could not be saved: " + e.message, "err");
      } finally {
        display.disabled = false;
      }
    };
  }

  // Original currency for each transaction
  installFormCurrency("txForm", "txAmount", "txCurrency");

  // Original currency for each essential
  installFormCurrency("itemForm", "itemCost", "itemCurrency");
}

function installFormCurrency(formId, amountId, currencyId) {
  const form = $(formId);
  const amount = $(amountId);

  if (!form || !amount || $(currencyId)) return;

  const wrapper = document.createElement("label");
  wrapper.className = "mintly-currency-field";
  wrapper.textContent = "Original currency";

  const select = makeCurrencySelect(currencyId, "USD");
  wrapper.appendChild(select);

  amount.insertAdjacentElement("afterend", wrapper);
}

function loadCurrencyPreference(u) {
  const saved = u?.user_metadata?.currency;

  currentCurrency = CURRENCIES[saved] ? saved : "USD";

  installCurrencySelectors();

  const selector = $("currencySelect");
  if (selector) selector.value = currentCurrency;
}

// OFFLINE STORAGE

function localPending() {
  try {
    return JSON.parse(localStorage.getItem(pendingKey()) || "[]");
  } catch {
    return [];
  }
}

function queue(op, table, payload) {
  const q = localPending();

  q.push({
    op,
    table,
    payload,
    queued_at: new Date().toISOString()
  });

  localStorage.setItem(pendingKey(), JSON.stringify(q));
  sync("Offline · changes queued", true);
}

async function write(table, payload, id = null) {
  if (!navigator.onLine) {
    queue(id ? "update" : "insert", table, {
      ...payload,
      ...(id ? { id } : {})
    });

    return { offline: true };
  }

  const q = supabase.from(table);

  const result = id
    ? await q.update(payload).eq("id", id)
    : await q.insert(payload);

  if (result.error) {
    if (!navigator.onLine) {
      queue(id ? "update" : "insert", table, {
        ...payload,
        ...(id ? { id } : {})
      });

      return { offline: true };
    }

    throw result.error;
  }

  sync("☁ Saved");
  return result;
}

// AUTHENTICATION

async function oauth(provider) {
  if (!supabase) return;

  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: window.location.href.split("#")[0]
      }
    });

    if (error) throw error;
  } catch (e) {
    $("authMsg").textContent = e.message;
  }
}

if ($("googleLogin")) {
  $("googleLogin").onclick = () => oauth("google");
}

if ($("facebookLogin")) {
  $("facebookLogin").onclick = () => oauth("facebook");
}

// PERSONAL AND HOUSEHOLD SPACES

function currentRole() {
  return spaces.find(s => s.id === activeSpace)?.role || "owner";
}

function canEdit() {
  return ["owner", "admin", "editor"].includes(currentRole());
}

async function loadSpaces() {
  const { data, error } = await supabase
    .from("space_members")
    .select("space_id,role,spaces(id,name,kind)")
    .eq("user_id", user.id);

  if (error) throw error;

  spaces = (data || [])
    .map(x => ({ ...x.spaces, role: x.role }))
    .filter(x => x.id);

  if (!spaces.length) {
    const { data: spaceId, error: createError } =
      await supabase.rpc("create_personal_space");

    if (createError) throw createError;

    const { data: s, error: spaceError } = await supabase
      .from("spaces")
      .select("id,name,kind")
      .eq("id", spaceId)
      .single();

    if (spaceError) throw spaceError;

    spaces = [{ ...s, role: "owner" }];
  }

  if (!activeSpace || !spaces.some(s => s.id === activeSpace)) {
    activeSpace = spaces[0].id;
  }

  $("spaceSelect").innerHTML = spaces.map(s =>
    `<option value="${s.id}">${escapeHtml(s.name)}${s.kind === "personal" ? " · Personal" : " · Household"}</option>`
  ).join("");

  $("spaceSelect").value = activeSpace;

  updateSpaceUI();
}

function updateSpaceUI() {
  const s = spaces.find(x => x.id === activeSpace);

  $("spaceDescription").textContent =
    s?.kind === "personal"
      ? "Private personal space"
      : "Shared household space";

  $("privacyNote").textContent =
    s?.kind === "personal"
      ? "Personal space: only you can access this information."
      : "Household space: records here are shared with authorised household members.";

  $("newHousehold").classList.toggle(
    "hidden",
    s?.kind === "household"
  );
}

// LOAD DASHBOARD DATA

async function loadData() {
  if (!activeSpace) return;

  const [t, e] = await Promise.all([
    supabase
      .from("transactions")
      .select("*")
      .eq("space_id", activeSpace)
      .order("created_at", { ascending: false }),

    supabase
      .from("essentials")
      .select("*")
      .eq("space_id", activeSpace)
      .order("name")
  ]);

  if (t.error) throw t.error;
  if (e.error) throw e.error;

  transactions = t.data || [];
  essentials = e.data || [];

  render();
}

function render() {
  const inc = transactions
    .filter(x => x.type === "income")
    .reduce((a, x) => {
      const value = convertAmount(
        x.amount,
        x.currency || "USD",
        currentCurrency,
        x.fx_rates
      );
      return a + (value ?? 0);
    }, 0);

  const exp = transactions
    .filter(x => x.type === "expense")
    .reduce((a, x) => {
      const value = convertAmount(
        x.amount,
        x.currency || "USD",
        currentCurrency,
        x.fx_rates
      );
      return a + (value ?? 0);
    }, 0);

  $("totalIncome").textContent =
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currentCurrency
    }).format(inc);

  $("totalExpense").textContent =
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currentCurrency
    }).format(exp);

  const balance = inc - exp;
  $("balance").textContent =
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currentCurrency
    }).format(balance);
  $("balance").style.color = balance < 0 ? "var(--red)" : "";

  $("itemCount").textContent = essentials.length;

  $("recent").innerHTML =
    transactions.slice(0, 5).map(x => `
      <div class="item row">
        <div>
          <span>${escapeHtml(x.description)}</span>
          <div class="small">${formatDate(x.created_at)}</div>
        </div>
        <b>${x.type === "income" ? "+" : "−"}${formatMoney(
          x.amount,
          x.currency || "USD",
          x.fx_rates
        )}</b>
      </div>
    `).join("") || "Nothing here yet.";

  $("transactions").innerHTML =
    transactions.map(x => `
      <div class="item row">
        <div>
          <b>${escapeHtml(x.description)}</b>
          <div class="small">${formatDate(x.created_at)}</div>
          <div class="small">
            ${escapeHtml(x.category || "General")} · ${escapeHtml(x.type)}
          </div>
          <div class="small">
            Original: ${formatOriginalMoney(
              x.amount,
              x.currency || "USD"
            )}
          </div>
        </div>
        <div style="text-align:right">
          <b>${formatMoney(
            x.amount,
            x.currency || "USD",
            x.fx_rates
          )}</b>
          ${canEdit() ? `
            <div>
              <button class="danger" data-del-tx="${x.id}">
                Delete
              </button>
            </div>
          ` : ""}
        </div>
      </div>
    `).join("") || "No transactions yet.";

  $("essentialsList").innerHTML =
    essentials.map(x => `
      <div class="item row">
        <div>
          <b>${escapeHtml(x.name)}</b>
          <div class="small">
            ${formatMoney(x.estimated_cost, x.currency || "USD")}
            · every ${x.restock_days} days
          </div>
          <div class="small">
            Original: ${formatOriginalMoney(
              x.estimated_cost,
              x.currency || "USD"
            )}
          </div>
          <div class="small ${getDueStatus(x).overdue ? "due-overdue" : "due-status"}">${getDueStatus(x).label}</div>
        </div>
        <div class="actions">
          ${canEdit() ? `
            <button class="secondary" data-edit-item="${x.id}">Edit</button>
            <button class="danger" data-del-item="${x.id}">Delete</button>
          ` : ""}
        </div>
      </div>
    `).join("") || "No essentials yet.";

  document.querySelectorAll("[data-del-tx]").forEach(b => {
    b.onclick = () => deleteRecord("transactions", b.dataset.delTx);
  });

  document.querySelectorAll("[data-del-item]").forEach(b => {
    b.onclick = () => deleteRecord("essentials", b.dataset.delItem);
  });

  document.querySelectorAll("[data-edit-item]").forEach(b => {
    b.onclick = () => editItem(b.dataset.editItem);
  });
}

// DELETE RECORDS

async function deleteRecord(table, id) {
  if (!canEdit() || !confirm("Delete this record?")) return;

  const { error } = await supabase
    .from(table)
    .delete()
    .eq("id", id);

  if (error) {
    message(error.message, "err");
  } else {
    message("Deleted");
    await loadData();
  }
}

// EDIT ESSENTIALS

async function editItem(id) {
  const x = essentials.find(y => y.id === id);
  if (!x) return;

  const name = prompt("Item name", x.name);
  if (name === null) return;

  const cost = prompt("Estimated cost", x.estimated_cost);
  if (cost === null) return;

  const days = prompt("Restock interval in days", x.restock_days);
  if (days === null) return;

  const currency = prompt(
    "Original currency (USD, PKR, GBP, EUR, AED, ZAR)",
    x.currency || "USD"
  );

  if (currency === null) return;

  const selectedCurrency = currency.trim().toUpperCase();

  if (!CURRENCIES[selectedCurrency]) {
    return message("Please enter a supported currency code.", "err");
  }

  try {
    const r = await write("essentials", {
      name,
      estimated_cost: Number(cost),
      restock_days: Number(days),
      currency: selectedCurrency
    }, id);

    if (r?.error) throw r.error;

    if (!r?.offline) await loadData();
    else message("Edit saved on this device; waiting to sync.");
  } catch (e) {
    message(e.message, "err");
  }
}

// EMAIL LOGIN AND SIGNUP

$("authForm").addEventListener("submit", async ev => {
  ev.preventDefault();

  if (!configured) {
    $("authMsg").textContent =
      "First configure config.js with your Supabase project URL and publishable/anon key. See README.";

    return;
  }

  const email = $("email").value;
  const password = $("password").value;

  try {
    const r = mode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });

    if (r.error) throw r.error;

    $("authMsg").textContent =
      mode === "signup"
        ? "Account created. Check your email if confirmation is enabled."
        : "Signed in.";

    if (r.data.session) {
      await start(r.data.user);
    }
  } catch (e) {
    $("authMsg").textContent = e.message;
  }
});

$("loginMode").onclick = () => setMode("login");
$("signupMode").onclick = () => setMode("signup");

function setMode(m) {
  mode = m;

  $("loginMode").classList.toggle("active", m === "login");
  $("signupMode").classList.toggle("active", m === "signup");

  $("authSubmit").textContent =
    m === "login" ? "Sign in" : "Create account";
}

// START APPLICATION

async function start(u) {
  if (!u || startingUserId === u.id) return;

  startingUserId = u.id;
  user = u;

  loadCurrencyPreference(u);

  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("accountTop").classList.remove("hidden");

  try {
    await loadRates();
    installCurrencySelectors();

    // A user arriving through an invitation link is authenticated by Supabase.
    // Complete any pending household invitations for this verified account
    // before loading the spaces available to them.
    let acceptedInvitations = 0;
    let acceptanceWarning = "";
    const { data: acceptance, error: acceptanceError } =
      await supabase.functions.invoke("accept-invitations");

    if (acceptanceError) {
      console.error("MINTLY invitation acceptance failed:", acceptanceError);
      acceptanceWarning = "Invitation acceptance couldn't complete: " + acceptanceError.message;
    } else {
      acceptedInvitations = Number(acceptance?.accepted_count || 0);
      if (acceptance?.warnings?.length) {
        acceptanceWarning = acceptance.warnings.join(" ");
      } else if (Number(acceptance?.pending_count || 0) > 0 && acceptedInvitations === 0) {
        acceptanceWarning = "A pending invitation was found, but MINTLY couldn't add this account. Please try refreshing or contact the household owner.";
      }
    }

    await loadSpaces();
    await loadData();
    await loadMembers();
    await flushQueue();

    if (acceptedInvitations > 0) {
      message(
        acceptedInvitations === 1
          ? "You've joined your household successfully."
          : `You've joined ${acceptedInvitations} households successfully.`
      );
    } else if (acceptanceWarning) {
      message(acceptanceWarning, "err");
    }
  } catch (e) {
    message(e.message, "err");
    console.error("MINTLY startup error:", e);
  }
}

// HOUSEHOLD MEMBERS

async function loadMembers() {
  if (!activeSpace) return;

  const { data, error } = await supabase
    .from("space_members")
    .select("user_id,role,profiles(email)")
    .eq("space_id", activeSpace);

  $("members").innerHTML = error
    ? `<span class="small">${escapeHtml(error.message)}</span>`
    : (data || []).map(m => `
        <div class="item row">
          <span>${escapeHtml(m.profiles?.email || "Household member")}</span>
          <span class="small">${escapeHtml(m.role)}</span>
        </div>
      `).join("") || "No members found.";
}

// SIGN OUT

$("signOut").onclick = async () => {
  await supabase.auth.signOut();
  location.reload();
};

// SPACE SELECTION

$("spaceSelect").onchange = async e => {
  activeSpace = e.target.value;

  updateSpaceUI();

  try {
    await loadData();
    await loadMembers();
  } catch (err) {
    message(err.message, "err");
  }
};

// CREATE HOUSEHOLD

$("newHousehold").onclick = async () => {
  const name = prompt("Name your household", "Our home");
  if (name === null) return;
  const cleanName = name.trim();
  if (!cleanName) {
    message("Please enter a household name.", "err");
    alert("Please enter a household name.");
    return;
  }

  const button = $("newHousehold");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Creating…";
  message("Creating your household…");

  try {
    const { data: spaceId, error } = await supabase.rpc(
      "create_household_space",
      { household_name: cleanName }
    );

    if (error) throw error;
    if (typeof spaceId !== "string" || !spaceId) {
      throw new Error("The database did not return a household ID.");
    }

    activeSpace = spaceId;
    await loadSpaces();

    const createdSpace = spaces.find(space => space.id === spaceId);
    if (!createdSpace || createdSpace.kind !== "household" || createdSpace.role !== "owner") {
      throw new Error("The household was created, but your owner membership could not be loaded. Refresh the page and check your spaces.");
    }

    $("spaceSelect").value = spaceId;
    updateSpaceUI();
    await loadData();
    await loadMembers();
    document.querySelector('[data-tab="household"]').click();
    message("Household created successfully. You can now invite members.");
  } catch (e) {
    console.error("MINTLY household creation failed:", e);
    const detail = e?.message || String(e);
    message("Household creation failed: " + detail, "err");
    alert("MINTLY couldn't create the household:\n\n" + detail);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
};

// ADD TRANSACTION

$("txForm").onsubmit = async ev => {
  ev.preventDefault();

  if (!canEdit()) {
    return message("You have view-only access.", "err");
  }

  const currency = $("txCurrency")?.value || "USD";

  if (!CURRENCIES[currency]) {
    return message("Choose a supported transaction currency.", "err");
  }

  try {
    await loadRates();

    const snapshot = getSnapshot();

    if (!snapshot.rates[currency]) {
      throw new Error(
        `No exchange rate is available for ${currency}. Please try again online.`
      );
    }

    const r = await write("transactions", {
      space_id: activeSpace,
      user_id: user.id,
      type: $("txType").value,
      amount: Number($("txAmount").value),
      description: $("txDescription").value,
      category: $("txCategory").value || "General",
      currency,
      fx_rates: snapshot
    });

    if (r?.error) throw r.error;

    ev.target.reset();

    if (!r?.offline) await loadData();

    message(
      r?.offline
        ? "Saved on this device; waiting to sync."
        : "Transaction added."
    );

  } catch (e) {
    message(e.message, "err");
  }
};

// ADD ESSENTIAL

$("itemForm").onsubmit = async ev => {
  ev.preventDefault();

  if (!canEdit()) {
    return message("You have view-only access.", "err");
  }

  const currency = $("itemCurrency")?.value || "USD";

  if (!CURRENCIES[currency]) {
    return message("Choose a supported essential currency.", "err");
  }

  try {
    const r = await write("essentials", {
      space_id: activeSpace,
      user_id: user.id,
      name: $("itemName").value,
      estimated_cost: Number($("itemCost").value || 0),
      restock_days: Number($("itemDays").value || 30),
      last_purchased: $("itemDate").value || null,
      currency
    });

    if (r?.error) throw r.error;

    ev.target.reset();

    if (!r?.offline) await loadData();

    message(
      r?.offline
        ? "Saved on this device; waiting to sync."
        : "Essential added."
    );

  } catch (e) {
    message(e.message, "err");
  }
};

// INVITE HOUSEHOLD MEMBER

$("inviteForm").onsubmit = async ev => {
  ev.preventDefault();
  const submit = ev.target.querySelector("button");
  const originalLabel = submit?.textContent;
  if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }
  $("inviteMsg").textContent = "";

  try {
    const selectedSpace = spaces.find(space => space.id === activeSpace);
    if (selectedSpace?.kind !== "household") throw new Error("Invitations can only be sent from a household space.");
    if (!["owner", "admin"].includes(currentRole())) throw new Error("Only household owners and admins can invite members.");
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) throw new Error("Your session has expired. Please sign in again.");

    const { data, error } = await supabase.functions.invoke("invite-member", {
      body: { space_id: activeSpace, email: $("inviteEmail").value.trim(), role: $("inviteRole").value },
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (error) {
      const details = error.context?.clone ? await error.context.clone().json().catch(() => null) : null;
      throw new Error(details?.error || error.message || "The invitation service could not be reached.");
    }
    if (data?.error) throw new Error(data.error);
    $("inviteMsg").textContent = data?.message || "Invitation sent.";
    ev.target.reset();
    await loadMembers();
  } catch (e) {
    console.error("MINTLY invitation failed:", e);
    $("inviteMsg").textContent = "Invitation failed: " + e.message;
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = originalLabel || "Send invitation"; }
  }
};

// NAVIGATION TABS

document.querySelectorAll("[data-tab]").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach(x =>
      x.classList.toggle("active", x === b)
    );

    document.querySelectorAll(".tabview").forEach(x =>
      x.classList.toggle("hidden", x.id !== b.dataset.tab)
    );

    if (b.dataset.tab === "household") {
      loadMembers();
    }
  };
});

// OFFLINE SUPPORT

window.addEventListener("online", async () => {
  await loadRates(true);
  await flushQueue();
});

window.addEventListener("offline", () =>
  sync("Offline · changes will queue", true)
);

async function flushQueue() {
  if (!user || !navigator.onLine) return;

  const q = localPending();

  if (!q.length) {
    sync("☁ All changes synced");
    return;
  }

  sync("Syncing offline changes…");

  const remaining = [];

  for (const x of q) {
    try {
      const req = supabase.from(x.table);

      const r = x.op === "update"
        ? await req.update(
            Object.fromEntries(
              Object.entries(x.payload).filter(([k]) => k !== "id")
            )
          ).eq("id", x.payload.id)
        : await req.insert(x.payload);

      if (r.error) throw r.error;

    } catch (e) {
      console.error("Offline sync failed:", e);
      remaining.push(x);
    }
  }

  localStorage.setItem(
    pendingKey(),
    JSON.stringify(remaining)
  );

  sync(
    remaining.length
      ? `Sync paused · ${remaining.length} pending`
      : "☁ All changes synced",
    !!remaining.length
  );

  await loadData();
}

// SUPABASE INITIALISATION

if (configured) {
  supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  supabase.auth.getSession().then(({ data, error }) => {
    if (error) {
      console.error("Session error:", error);
      return;
    }

    if (data.session) {
      start(data.session.user);
    }
  });

  supabase.auth.onAuthStateChange((event, session) => {
    if (session && (!user || user.id !== session.user.id)) {
      start(session.user);
    }
  });

} else {
  $("authMsg").textContent =
    "Cloud setup required: add your Supabase URL and publishable key to config.js. The setup guide is in README.md.";
}
