package com.plagnito.toulouseville;

import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/**
 * Trajets planifiés : la logique pure, sans Android, couverte par PlanRulesTest.
 *
 * Le réseau vit à l'heure de Paris, quel que soit le fuseau du téléphone : un
 * trajet planifié « 08:15 » veut dire 08:15 à Toulouse. Les mêmes règles
 * existent côté serveur (lib/account.mjs) ; elles sont redites ici parce qu'un
 * rappel doit pouvoir se reprogrammer sans réseau.
 */
final class PlanRules {
    static final ZoneId PARIS = ZoneId.of("Europe/Paris");
    private static final String[] DAYS = {"", "lun", "mar", "mer", "jeu", "ven", "sam", "dim"};
    private PlanRules() { }

    /**
     * La prochaine occurrence, en secondes depuis l'époque, ou -1 s'il n'y en a plus.
     * `date` ("AAAA-MM-JJ") pour un trajet d'un jour, sinon `days` (1 = lundi … 7 = dimanche).
     * `tolerance` : une occurrence commencée depuis moins que cela compte encore.
     */
    static long next(String time, String date, int[] days, long nowSeconds, long tolerance) {
        LocalTime at;
        try { at = LocalTime.parse(time); } catch (Exception e) { return -1; }
        if (date != null && !date.isEmpty()) {
            try {
                long when = LocalDate.parse(date).atTime(at).atZone(PARIS).toEpochSecond();
                return when >= nowSeconds - tolerance ? when : -1;
            } catch (Exception e) { return -1; }
        }
        if (days == null || days.length == 0) return -1;
        LocalDate today = Instant.ofEpochSecond(nowSeconds).atZone(PARIS).toLocalDate();
        for (int i = 0; i <= 7; i++) {
            LocalDate day = today.plusDays(i);
            boolean wanted = false;
            for (int d : days) if (d == day.getDayOfWeek().getValue()) wanted = true;
            if (!wanted) continue;
            long when = day.atTime(at).atZone(PARIS).toEpochSecond();
            if (when >= nowSeconds - tolerance) return when;
        }
        return -1;
    }

    /** « arriver avant 08:15 · en semaine », « partir à 10:00 · 24 déc. ». */
    static String rhythm(String mode, String time, String date, int[] days) {
        String sense = "arriver".equals(mode) ? "arriver avant " : "partir à ";
        if (date != null && !date.isEmpty()) {
            try { return sense + time + " · " + LocalDate.parse(date).format(DateTimeFormatter.ofPattern("d MMM", Locale.FRENCH)); }
            catch (Exception e) { return sense + time + " · " + date; }
        }
        if (days == null || days.length == 0) return sense + time;
        if (days.length == 7) return sense + time + " · tous les jours";
        if (days.length == 5 && days[0] == 1 && days[4] == 5) return sense + time + " · en semaine";
        StringBuilder list = new StringBuilder();
        for (int d : days) { if (list.length() > 0) list.append(", "); list.append(d >= 1 && d <= 7 ? DAYS[d] : "?"); }
        return sense + time + " · " + list;
    }

    /** L'instant d'un rappel, ou -1 s'il est déjà passé (on ne sonne pas pour un rappel manqué). */
    static long reminderAt(long occurrenceSeconds, int minutesBefore, long nowSeconds) {
        if (occurrenceSeconds < 0 || minutesBefore < 0) return -1;
        long at = occurrenceSeconds - minutesBefore * 60L;
        return at > nowSeconds + 20 ? at : -1;
    }

    /** « lun. 5 oct. 08:15 », à l'heure de Paris. */
    static String when(long seconds) {
        return Instant.ofEpochSecond(seconds).atZone(PARIS).format(DateTimeFormatter.ofPattern("EEE d MMM HH:mm", Locale.FRENCH));
    }
    static String clock(long seconds) {
        return Instant.ofEpochSecond(seconds).atZone(PARIS).format(DateTimeFormatter.ofPattern("HH:mm", Locale.FRENCH));
    }
    /** « il y a 20 s », « il y a 3 min ». */
    static String age(long seconds) {
        return seconds < 60 ? "il y a " + seconds + " s" : seconds < 3600 ? "il y a " + Math.round(seconds / 60.0) + " min" : "il y a " + Math.round(seconds / 3600.0) + " h";
    }
}
