package com.plagnito.toulouseville;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;

/**
 * Ce que le téléphone garde du compte : le jeton de session, le pseudo, et de
 * quoi reprogrammer les rappels sans réseau. Préférences privées de
 * l'application (non sauvegardées : `allowBackup` est à false).
 *
 * Le jeton est lié au SERVEUR qui l'a délivré : changer de serveur dans les
 * réglages l'efface, pour ne jamais l'envoyer à une autre adresse.
 */
final class AccountStore {
    final SharedPreferences prefs;
    AccountStore(Context context) { prefs = context.getSharedPreferences("toulouse-account", Context.MODE_PRIVATE); }

    String token(String base) { return base.equals(prefs.getString("base", "")) ? prefs.getString("token", "") : ""; }
    String pseudo() { return prefs.getString("pseudo", ""); }
    void signIn(String base, String token, String pseudo) { prefs.edit().putString("base", base).putString("token", token).putString("pseudo", pseudo).apply(); }
    void signOut() { prefs.edit().remove("token").remove("pseudo").remove("base").remove("plans").apply(); }

    /** Les trajets planifiés tels que le serveur les a rendus la dernière fois. */
    JSONArray plans() { try { return new JSONArray(prefs.getString("plans", "[]")); } catch (Exception e) { return new JSONArray(); } }
    void plans(JSONArray plans) { prefs.edit().putString("plans", plans.toString()).apply(); }

    /** Le partage de position que CE téléphone alimente. */
    String shareId() { return prefs.getString("share_id", ""); }
    long shareExpire() { return prefs.getLong("share_expire", 0); }
    String shareNames() { return prefs.getString("share_names", ""); }
    String shareStatus() { return prefs.getString("share_status", ""); }
    void share(String id, long expire, String names) { prefs.edit().putString("share_id", id).putLong("share_expire", expire).putString("share_names", names).putString("share_status", "En attente d’une position").apply(); }
    void shareStatus(String status) { prefs.edit().putString("share_status", status).apply(); }
    void shareEnded() { prefs.edit().remove("share_id").remove("share_expire").remove("share_names").remove("share_status").apply(); }
}
