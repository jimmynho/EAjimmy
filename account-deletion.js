// Eaji — suppression complète d'un compte créateur (réservée à l'administrateur principal).
// Supprime le compte ET tout ce qui lui est rattaché (contenus, messages, cadeaux, soldes...)
// dans une seule opération : tout réussit, ou rien n'est modifié.
//
// L'ordre compte : on supprime d'abord ce qui dépend des autres, le compte en dernier.

const OWN_CONTENT = '(SELECT id FROM content_items WHERE creator_id = $1)';
const OWN_ADS = '(SELECT id FROM ad_subscriptions WHERE creator_id = $1)';
const OWN_LIVES = '(SELECT id FROM live_sessions WHERE creator_id = $1)';

const DELETION_STATEMENTS = [
  `DELETE FROM gifts WHERE from_creator_id = $1 OR to_creator_id = $1
     OR content_id IN ${OWN_CONTENT} OR live_session_id IN ${OWN_LIVES}`,
  `DELETE FROM content_reports WHERE reported_by = $1 OR content_id IN ${OWN_CONTENT}`,
  `DELETE FROM moderation_actions WHERE content_id IN ${OWN_CONTENT}`,
  `DELETE FROM ad_listings WHERE ad_subscription_id IN ${OWN_ADS} OR content_id IN ${OWN_CONTENT}`,
  `DELETE FROM ad_payments WHERE ad_subscription_id IN ${OWN_ADS}`,
  `DELETE FROM content_likes WHERE creator_id = $1 OR content_id IN ${OWN_CONTENT}`,
  `DELETE FROM content_comments WHERE creator_id = $1 OR content_id IN ${OWN_CONTENT}`,
  'DELETE FROM content_items WHERE creator_id = $1',
  'DELETE FROM ad_subscriptions WHERE creator_id = $1',
  'DELETE FROM live_sessions WHERE creator_id = $1',
  'DELETE FROM follows WHERE follower_id = $1 OR followed_id = $1',
  'DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1',
  'DELETE FROM calls WHERE caller_id = $1 OR callee_id = $1',
  'DELETE FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1',
  'DELETE FROM account_verifications WHERE creator_id = $1',
  'DELETE FROM login_attempts WHERE creator_id = $1',
  'DELETE FROM activity_logs WHERE creator_id = $1',
  'DELETE FROM payout_accounts WHERE creator_id = $1',
  'DELETE FROM transactions WHERE creator_id = $1',
  'DELETE FROM phone_change_requests WHERE creator_id = $1',
  'DELETE FROM subscriber_counts WHERE creator_id = $1',
  'DELETE FROM creator_balances WHERE creator_id = $1',
  'DELETE FROM admin_commissions WHERE creator_id = $1',
];

// `pool` = le pool pg du serveur. Renvoie true si le compte existait, false sinon.
async function deleteCreatorAccount(pool, creatorId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of DELETION_STATEMENTS) {
      await client.query(sql, [creatorId]);
    }
    const result = await client.query('DELETE FROM creators WHERE id = $1', [creatorId]);
    await client.query('COMMIT');
    return result.rowCount > 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { deleteCreatorAccount, DELETION_STATEMENTS };
