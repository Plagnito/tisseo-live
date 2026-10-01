package com.plagnito.toulouseville;

import android.app.*;
import android.content.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

/**
 * Rappels des trajets planifiés.
 *
 * Un rappel sonne à l'heure si l'utilisateur a accordé « Alarmes et rappels »
 * (Android 12+) ; sinon c'est une alarme inexacte, qu'Android peut retarder
 * jusqu'à une heure. La notification ne contient pas d'itinéraire : il sera
 * calculé à l'ouverture, avec les horaires du moment — un itinéraire figé la
 * veille serait faux le matin d'une perturbation.
 *
 * Les alarmes meurent au redémarrage du téléphone : ce récepteur les repose
 * (BOOT_COMPLETED), à partir des trajets gardés par AccountStore.
 */
public final class ReminderReceiver extends BroadcastReceiver {
    static final String RING = "com.plagnito.toulouseville.PLAN_REMINDER";
    private static final String CHANNEL = "plan_reminders";

    @Override public void onReceive(Context context, Intent intent) {
        AccountStore store = new AccountStore(context);
        if (RING.equals(intent.getAction())) {
            // Ce récepteur est exporté (il doit recevoir BOOT_COMPLETED) : une autre
            // application peut donc lui envoyer cette action. On n'affiche que ce
            // qui correspond à un trajet RÉELLEMENT planifié, avec le nom gardé ici
            // — jamais un texte venu de l'intention.
            String id = intent.getStringExtra("plan"), name = null, when = null;
            JSONArray known = store.plans();
            for (int i = 0; id != null && i < known.length(); i++) {
                JSONObject p = known.optJSONObject(i);
                if (p != null && id.equals(p.optString("id"))) { name = p.optString("nom"); when = PlanRules.rhythm(p.optString("mode"), p.optString("heure"), null, null); }
            }
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (name != null && manager.areNotificationsEnabled()) {
                manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Trajets planifiés", NotificationManager.IMPORTANCE_DEFAULT));
                Intent open = new Intent(context, MainActivity.class).putExtra("open_personal", "plan").putExtra("open_plan", id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                PendingIntent tap = PendingIntent.getActivity(context, id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                manager.notify(4500 + (id.hashCode() & 0xff), new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_city)
                        .setContentTitle(name.isEmpty() ? "Trajet planifié" : name)
                        .setContentText(when + " · touche pour l’itinéraire du moment")
                        .setContentIntent(tap).setAutoCancel(true).build());
            }
        }
        // Après une sonnerie comme après un redémarrage : reposer les suivantes.
        schedule(context, store.plans());
    }

    /**
     * (Re)pose une alarme par trajet planifié qui a un rappel. Annule celles des
     * trajets disparus. Appelée à chaque lecture du compte.
     */
    static void schedule(Context context, JSONArray plans) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        AccountStore store = new AccountStore(context);
        long now = System.currentTimeMillis() / 1000;
        Set<String> wanted = new HashSet<>();
        for (int i = 0; i < plans.length(); i++) {
            JSONObject p = plans.optJSONObject(i);
            if (p == null || p.isNull("rappel_min")) continue;
            String id = p.optString("id");
            JSONArray days = p.optJSONArray("jours");
            int[] list = new int[days == null ? 0 : days.length()];
            for (int k = 0; k < list.length; k++) list[k] = days.optInt(k);
            // Tolérance nulle : pour un rappel, l'occurrence « en cours » est déjà trop tard.
            String date = p.isNull("date") ? null : p.optString("date");
            long occurrence = PlanRules.next(p.optString("heure"), date, list, now, 0);
            long at = PlanRules.reminderAt(occurrence, p.optInt("rappel_min"), now);
            // Le rappel de la prochaine occurrence vient de sonner (ou son heure est
            // passée) : pour un trajet répété, on vise la suivante. Sans cela, un
            // trajet hebdomadaire ne sonnerait qu'une fois, jusqu'à la prochaine
            // ouverture de l'application.
            if (at < 0 && occurrence > 0 && date == null) {
                occurrence = PlanRules.next(p.optString("heure"), null, list, occurrence + 60, 0);
                at = PlanRules.reminderAt(occurrence, p.optInt("rappel_min"), now);
            }
            if (at < 0) continue;
            wanted.add(id);
            Intent ring = new Intent(context, ReminderReceiver.class).setAction(RING).putExtra("plan", id);
            // À l'heure si Android le permet ; sinon une alarme inexacte, qui — mesuré
            // sur un Galaxy A17 — peut être servie jusqu'à UNE HEURE plus tard.
            // L'écran de planification le dit et propose l'autorisation.
            PendingIntent target = pending(context, id, ring, PendingIntent.FLAG_UPDATE_CURRENT);
            if (exactAllowed(context)) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at * 1000, target);
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at * 1000, target);
        }
        for (String old : store.prefs.getStringSet("reminders", new HashSet<>())) {
            if (wanted.contains(old)) continue;
            PendingIntent stale = pending(context, old, new Intent(context, ReminderReceiver.class).setAction(RING), PendingIntent.FLAG_NO_CREATE);
            if (stale != null) { alarms.cancel(stale); stale.cancel(); }
        }
        store.prefs.edit().putStringSet("reminders", wanted).apply();
    }

    /** Android 12+ réserve les alarmes exactes aux applications que l'utilisateur a autorisées (« Alarmes et rappels »). */
    static boolean exactAllowed(Context context) {
        return android.os.Build.VERSION.SDK_INT < 31 || context.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    private static PendingIntent pending(Context context, String id, Intent intent, int flag) {
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, flag | PendingIntent.FLAG_IMMUTABLE);
    }
}
