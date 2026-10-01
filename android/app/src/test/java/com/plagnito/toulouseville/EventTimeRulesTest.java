package com.plagnito.toulouseville;

import org.junit.Test;
import static org.junit.Assert.*;
import java.time.Instant;

public class EventTimeRulesTest {
    @Test public void autumnClockChangePreservesBothPublishedOffsets() {
        long[] window = EventTimeRules.upcomingWindow("2026-10-25T02:15:00+02:00", "2026-10-25T02:45:00+01:00", 0);
        assertEquals(Instant.parse("2026-10-25T00:15:00Z").toEpochMilli(), window[0]);
        assertEquals(90 * 60_000, window[1] - window[0]);
    }
    @Test public void overnightSessionRemainsAvailableUntilItsActualEnd() {
        String begin = "2026-10-01T23:00:00+02:00", end = "2026-10-02T01:00:00+02:00";
        assertNotNull(EventTimeRules.upcomingWindow(begin, end, Instant.parse("2026-10-01T22:30:00Z").toEpochMilli()));
        assertNull(EventTimeRules.upcomingWindow(begin, end, Instant.parse("2026-10-01T23:00:00Z").toEpochMilli()));
    }
    @Test public void invalidOrReversedDatesCannotInventACalendarDuration() {
        assertNull(EventTimeRules.upcomingWindow("2026-10-01", "2026-10-02", 0));
        assertNull(EventTimeRules.upcomingWindow("2026-10-01T21:00:00Z", "2026-10-01T20:00:00Z", 0));
        assertNull(EventTimeRules.upcomingWindow("", "", 0));
    }
}
