// ============================================================
// Bank on Brooke — Shared Data API
//
// All Supabase reads/writes go through this so HTML files don't
// touch the database directly. Row-level security in Supabase means
// each Realtor automatically only sees their own buyers/listings.
//
// Drop in HTML AFTER bob-auth.js:
//   <script src="bob-auth.js"></script>
//   <script src="bob-api.js"></script>
//
// Usage:
//   const buyers = await BobApi.buyers.list();
//   const newBuyer = await BobApi.buyers.create({...});
//   await BobApi.buyers.update(id, { stage: 'closed' });
// ============================================================

(function (global) {
  'use strict';

  if (!global.BobAuth || !global.BobAuth.client) {
    console.error('[bob-api] BobAuth not loaded. Add bob-auth.js BEFORE bob-api.js.');
    return;
  }

  const sb = global.BobAuth.client();

  /**
   * Throws a clean Error if Supabase returned one.
   */
  function check(res, op) {
    if (res.error) {
      console.error('[bob-api] ' + op + ' failed:', res.error);
      throw new Error(res.error.message || 'Database error during ' + op);
    }
    return res.data;
  }

  // ── BUYERS ─────────────────────────────────────────────
  const buyers = {
    /** List all buyers for the logged-in Realtor. RLS handles the filter. */
    async list() {
      return check(
        await sb.from('buyers').select('*').order('created_at', { ascending: false }),
        'buyers.list'
      );
    },

    /** Get one buyer by ID. */
    async get(id) {
      return check(
        await sb.from('buyers').select('*').eq('id', id).single(),
        'buyers.get'
      );
    },

    /** Create a new buyer. Pass the realtor_id from BobAuth.currentRealtor(). */
    async create(buyer) {
      return check(
        await sb.from('buyers').insert(buyer).select().single(),
        'buyers.create'
      );
    },

    /** Update fields on a buyer. */
    async update(id, fields) {
      return check(
        await sb.from('buyers').update(fields).eq('id', id).select().single(),
        'buyers.update'
      );
    },

    /** Delete a buyer (and all linked favorites, checklist progress, workflow steps via cascade). */
    async remove(id) {
      return check(
        await sb.from('buyers').delete().eq('id', id),
        'buyers.remove'
      );
    },

    /**
     * Convenience: flip the "client requested Brooke contact them" flag.
     * This is the toggle that triggers the email to Brooke.
     */
    async setRequestBrookeContact(buyerId, requested, notes = null) {
      return check(
        await sb.from('buyers').update({
          contact_brooke_flag: requested,
          contact_brooke_notes: notes,
        }).eq('id', buyerId).select().single(),
        'buyers.setRequestBrookeContact'
      );
    },

    /**
     * Convenience: flip the "Brooke may contact this client" consent flag.
     * Does NOT trigger an email — this is just a permission record.
     */
    async setBrookeConsent(buyerId, consented) {
      return check(
        await sb.from('buyers').update({
          contact_brooke_consent: consented,
        }).eq('id', buyerId).select().single(),
        'buyers.setBrookeConsent'
      );
    },
  };

  // ── FEATURED LISTINGS ──────────────────────────────────
  const listings = {
    async list({ activeOnly = true } = {}) {
      let q = sb.from('featured_listings').select('*').order('created_at', { ascending: false });
      if (activeOnly) q = q.eq('is_active', true);
      return check(await q, 'listings.list');
    },

    /** List listings for a SPECIFIC realtor (used by the buyer-facing hub). */
    async listForRealtor(realtorId) {
      return check(
        await sb.from('featured_listings')
          .select('*')
          .eq('realtor_id', realtorId)
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
        'listings.listForRealtor'
      );
    },

    async get(id) {
      return check(
        await sb.from('featured_listings').select('*').eq('id', id).single(),
        'listings.get'
      );
    },

    async create(listing) {
      return check(
        await sb.from('featured_listings').insert(listing).select().single(),
        'listings.create'
      );
    },

    async update(id, fields) {
      return check(
        await sb.from('featured_listings').update(fields).eq('id', id).select().single(),
        'listings.update'
      );
    },

    async remove(id) {
      return check(
        await sb.from('featured_listings').delete().eq('id', id),
        'listings.remove'
      );
    },
  };

  // ── BUYER CHECKLIST PROGRESS ───────────────────────────
  const checklist = {
    async listForBuyer(buyerId) {
      return check(
        await sb.from('buyer_checklist_progress').select('*').eq('buyer_id', buyerId),
        'checklist.listForBuyer'
      );
    },

    /** Upsert (insert or update) a single checklist step for a buyer. */
    async setStep(buyerId, stepKey, completed) {
      return check(
        await sb.from('buyer_checklist_progress').upsert({
          buyer_id: buyerId,
          step_key: stepKey,
          completed,
          completed_at: completed ? new Date().toISOString() : null,
        }, { onConflict: 'buyer_id,step_key' }).select().single(),
        'checklist.setStep'
      );
    },
  };

  // ── BUYER FAVORITES (listings) ─────────────────────────
  const favorites = {
    async listForBuyer(buyerId) {
      return check(
        await sb.from('buyer_favorites')
          .select('*, featured_listings(*)')
          .eq('buyer_id', buyerId),
        'favorites.listForBuyer'
      );
    },

    async toggle(buyerId, listingId) {
      // Try delete first; if no rows deleted, insert
      const del = await sb.from('buyer_favorites')
        .delete()
        .eq('buyer_id', buyerId)
        .eq('listing_id', listingId)
        .select();

      if (del.error) throw new Error(del.error.message);
      if (del.data && del.data.length > 0) {
        return { favorited: false };
      }

      const ins = await sb.from('buyer_favorites')
        .insert({ buyer_id: buyerId, listing_id: listingId })
        .select()
        .single();
      if (ins.error) throw new Error(ins.error.message);
      return { favorited: true, row: ins.data };
    },
  };

  // ── EMAIL LOG ──────────────────────────────────────────
  const emailLog = {
    /** Record that a templated email was sent. Just logging — doesn't actually send. */
    async log({ buyerId, templateName, subject }) {
      const realtor = await global.BobAuth.currentRealtor();
      if (!realtor) throw new Error('Not logged in.');
      return check(
        await sb.from('email_log').insert({
          realtor_id: realtor.id,
          buyer_id: buyerId,
          template_name: templateName,
          subject,
        }).select().single(),
        'emailLog.log'
      );
    },

    async listRecent(limit = 50) {
      return check(
        await sb.from('email_log')
          .select('*, buyers(name, email)')
          .order('sent_at', { ascending: false })
          .limit(limit),
        'emailLog.listRecent'
      );
    },
  };

  // ── WORKFLOW STEPS ─────────────────────────────────────
  const workflows = {
    async listDue() {
      const today = new Date().toISOString().slice(0, 10);
      return check(
        await sb.from('workflow_steps')
          .select('*, buyers(name, email)')
          .eq('done', false)
          .lte('due_date', today)
          .order('due_date'),
        'workflows.listDue'
      );
    },

    async create(step) {
      return check(
        await sb.from('workflow_steps').insert(step).select().single(),
        'workflows.create'
      );
    },

    async markDone(id) {
      return check(
        await sb.from('workflow_steps').update({
          done: true,
          done_at: new Date().toISOString(),
        }).eq('id', id).select().single(),
        'workflows.markDone'
      );
    },
  };

  // ── REALTOR PROFILE ────────────────────────────────────
  const profile = {
    /** Update the logged-in Realtor's profile (name, company, phone, photo, bio). */
    async update(fields) {
      const realtor = await global.BobAuth.currentRealtor();
      if (!realtor) throw new Error('Not logged in.');
      return check(
        await sb.from('realtors').update(fields).eq('id', realtor.id).select().single(),
        'profile.update'
      );
    },
  };

  // ── BROOKE CONTACT REQUESTS ────────────────────────────
  const contactRequests = {
    /** Realtors see only their own. Brooke (admin) sees all. */
    async list() {
      return check(
        await sb.from('brooke_contact_requests')
          .select('*, buyers(name, phone, email), realtors(name, company)')
          .order('requested_at', { ascending: false }),
        'contactRequests.list'
      );
    },

    /** Brooke marks a request as contacted (admin only by RLS). */
    async markContacted(id, brookeNotes) {
      return check(
        await sb.from('brooke_contact_requests').update({
          status: 'contacted',
          contacted_at: new Date().toISOString(),
          brooke_notes: brookeNotes,
        }).eq('id', id).select().single(),
        'contactRequests.markContacted'
      );
    },
  };

  // ── EXPORT ─────────────────────────────────────────────
  global.BobApi = {
    buyers,
    listings,
    checklist,
    favorites,
    emailLog,
    workflows,
    profile,
    contactRequests,
    raw: sb,  // escape hatch if you need direct Supabase access
  };

})(window);
