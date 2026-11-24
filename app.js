<CodeBlock language="javascript" editable>
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
const RATE_CACHE_KEY = "mintly-exchange-rates";
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
const pendingKey = () => mintly-pending-$DIL0;
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
"&": "&",
"<": "<",
">": ">",
'"': """,
"'": "'"
}[c]));
}
// EXCHANGE RATES
function readRateCache() {
try {
return JSON.parse(localStorage.getItem(RATE_CACHE_KEY) || "null");
} catch {
return null;
}
function saveRateCache(snapshot) {
try {
localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(snapshot));
} catch (e) {
console.warn("Could not cache exchange rates:", e);
}
}
async function loadRates(force = false) {
const cached = readRateCache();
// Check that the cache contains every currency MINTLY supports.
const hasRequiredRates = rates =>
rates &&
Object.keys(CURRENCIES).every(code => {
const value = Number(rates[code]);
return Number.isFinite(value) && value > 0;
});  
// Use a valid cache if it is less than 24 hours old.
if (
!force &&
hasRequiredRates(cached?.rates) &&
cached.savedAt &&
Date.now() - cached.savedAt < RATE_CACHE_MAX_AGE
) {
currentRates = cached.rates;
currentRateDate = cached.date;
return;
}
// If offline, use the cache if available.
if (!navigator.onLine) {
if (hasRequiredRates(cached?.rates)) {
currentRates = cached.rates;
currentRateDate = cached.date;
}
return;
}
try {
const response = await fetch(
"https://api.frankfurter.dev/v2/rates?base=USD⁠"
);

if (!response.ok) {
throw new Error("Exchange-rate service unavailable.");
}
const result = await response.json();
if (!Array.isArray(result)) {
throw new Error("Unexpected exchange-rate response.");
}
}
// Convert the v2 response rows into MINTLY's rates object.
const rates = { USD: 1 };
result.forEach(item => {
if (
item.base === "USD" &&
item.quote &&
Number.isFinite(Number(item.rate))
) {
rates[item.quote] = Number(item.rate);
}
});
// Make sure every supported currency has a valid rate.
const missing = Object.keys(CURRENCIES).filter(
code => !rates[code] || rates[code] <= 0
);
if (missing.length) {
throw new Error(
"Missing exchange rates: " + missing.join(", ")
);
}
currentRates = rates;
// Use the most recent date in the returned data.
currentRateDate = result.reduce(
(latest, item) =>
item.date > latest ? item.date : latest,
""
);
saveRateCache({
base: "USD",
rates: currentRates,
date: currentRateDate,
savedAt: Date.now()
});
} catch (e) {
console.warn("Exchange-rate loading failed:", e);
// Only fall back to a cache containing all supported currencies.
if (hasRequiredRates(cached?.rates)) {
currentRates = cached.rates;
currentRateDate = cached.date;
} else {
currentRates = { USD: 1 };
currentRateDate = null;
}
}
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
return $DIL0 $DIL1;
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
// CURRENCY SELECTORS
function styleCurrencyControls() {
if ($("mintlyCurrencyStyles")) return;
const style = document.createElement("style");
style.id = "mintlyCurrencyStyles";
style.textContent = `
.mintly-currency-field
