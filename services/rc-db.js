// services/rc-db.js
//
// P.AI's seam onto RC Tracker's Supabase. Follow-ups, SMS history and consent
// live there, and this reads and writes them in place rather than migrating —
// no migration means no window in which rows can be lost.
//
// Spec Phase 7 consolidates into pai-db. This file is the only thing that has
// to change when that happens, which is the point of having it.
//
// Two clients, mirroring RC Tracker: anon for ordinary reads, service for the
// tables under row-level security (sms_messages, sms_consent, sms_reminders).

const { createClient } = require('@supabase/supabase-js');

let anon    = null;
let service = null;

function makeClient(key) {
  const url = process.env.SUPABASE_URL;
  if (!url || !key) return null;        // not configured — callers degrade
  return createClient(url, key, { auth: { persistSession: false } });
}

function getClient() {
  if (!anon) anon = makeClient(process.env.SUPABASE_ANON_KEY);
  return anon;
}

function getServiceClient() {
  if (!service) service = makeClient(process.env.SUPABASE_SERVICE_KEY);
  return service;
}

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

module.exports = { getClient, getServiceClient, isConfigured };
