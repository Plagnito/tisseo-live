package com.plagnito.toulouseville;

import static org.junit.Assert.*;
import org.junit.Test;
import java.time.*;

public class PlanRulesTest {
    private static long paris(int y, int mo, int d, int h, int mi) {
        return LocalDateTime.of(y, mo, d, h, mi).atZone(PlanRules.PARIS).toEpochSecond();
    }
    private static final int[] WEEK = {1, 2, 3, 4, 5};
    private static final long QUARTER = 15 * 60;

    @Test public void datedTripIsItsOwnOccurrenceUntilItIsOver() {
        long monday7 = paris(2026, 10, 5, 7, 0); // lundi 5 octobre 2026
        assertEquals(paris(2026, 10, 5, 8, 15), PlanRules.next("08:15", "2026-10-05", null, monday7, QUARTER));
        // À 08:20, le trajet de 08:15 n'est pas encore « passé ».
        assertEquals(paris(2026, 10, 5, 8, 15), PlanRules.next("08:15", "2026-10-05", null, paris(2026, 10, 5, 8, 20), QUARTER));
        assertEquals(-1, PlanRules.next("08:15", "2026-10-05", null, paris(2026, 10, 5, 9, 0), QUARTER));
    }

    @Test public void repeatedTripFindsTheNextWantedDay() {
        assertEquals(paris(2026, 10, 5, 8, 15), PlanRules.next("08:15", null, WEEK, paris(2026, 10, 5, 7, 0), QUARTER));
        assertEquals(paris(2026, 10, 6, 8, 15), PlanRules.next("08:15", null, WEEK, paris(2026, 10, 5, 9, 0), QUARTER));
        // Vendredi 9 h : le prochain jour de semaine est lundi.
        assertEquals(paris(2026, 10, 12, 8, 15), PlanRules.next("08:15", null, WEEK, paris(2026, 10, 9, 9, 0), QUARTER));
        assertEquals(paris(2026, 10, 11, 10, 0), PlanRules.next("10:00", null, new int[]{7}, paris(2026, 10, 5, 7, 0), QUARTER));
    }

    @Test public void clockChangeDoesNotMoveTheTrip() {
        // Passage à l'heure d'hiver dans la nuit du 24 au 25 octobre 2026.
        long after = PlanRules.next("08:15", null, WEEK, paris(2026, 10, 23, 9, 0), QUARTER);
        assertEquals(paris(2026, 10, 26, 8, 15), after);
        assertEquals("08:15", PlanRules.clock(after));
    }

    @Test public void parisTimeWhateverThePhoneZone() {
        // 08:15 à Paris en été = 06:15 UTC ; en hiver = 07:15 UTC.
        assertEquals(LocalDateTime.of(2026, 7, 14, 6, 15).toEpochSecond(ZoneOffset.UTC), PlanRules.next("08:15", "2026-07-14", null, 0, 0));
        assertEquals(LocalDateTime.of(2026, 1, 15, 7, 15).toEpochSecond(ZoneOffset.UTC), PlanRules.next("08:15", "2026-01-15", null, 0, 0));
    }

    @Test public void unreadableInputGivesNoOccurrence() {
        assertEquals(-1, PlanRules.next("midi", "2026-10-05", null, 0, 0));
        assertEquals(-1, PlanRules.next("08:15", "2026-02-31", null, 0, 0));
        assertEquals(-1, PlanRules.next("08:15", null, new int[0], 0, 0));
        assertEquals(-1, PlanRules.next("08:15", null, null, 0, 0));
    }

    @Test public void rhythmReadsLikeASentence() {
        assertEquals("arriver avant 08:15 · en semaine", PlanRules.rhythm("arriver", "08:15", null, WEEK));
        assertEquals("partir à 10:00 · sam, dim", PlanRules.rhythm("partir", "10:00", null, new int[]{6, 7}));
        assertEquals("partir à 10:00 · tous les jours", PlanRules.rhythm("partir", "10:00", null, new int[]{1, 2, 3, 4, 5, 6, 7}));
        assertTrue(PlanRules.rhythm("partir", "10:00", "2026-12-24", null).startsWith("partir à 10:00 · 24 "));
    }

    @Test public void aMissedReminderDoesNotRing() {
        long trip = paris(2026, 10, 5, 8, 15);
        assertEquals(trip - 600, PlanRules.reminderAt(trip, 10, paris(2026, 10, 5, 7, 0)));
        assertEquals(trip, PlanRules.reminderAt(trip, 0, paris(2026, 10, 5, 7, 0)));
        assertEquals(-1, PlanRules.reminderAt(trip, 10, paris(2026, 10, 5, 8, 10)));
        assertEquals(-1, PlanRules.reminderAt(-1, 10, 0));
    }

    @Test public void ageIsSaidInTheRightUnit() {
        assertEquals("il y a 20 s", PlanRules.age(20));
        assertEquals("il y a 3 min", PlanRules.age(170));
        assertEquals("il y a 2 h", PlanRules.age(7300));
    }
}
