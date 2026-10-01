package com.plagnito.toulouseville;

import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;

final class EventTimeRules {
    /** Only a published, valid session becomes a calendar entry; never its date envelope. */
    static long[] upcomingWindow(String begin, String end, long now) {
        try {
            long first = OffsetDateTime.parse(begin).toInstant().toEpochMilli();
            long last = OffsetDateTime.parse(end).toInstant().toEpochMilli();
            return last > first && last > now ? new long[]{first, last} : null;
        } catch (DateTimeParseException | ArithmeticException e) {
            return null;
        }
    }
}
