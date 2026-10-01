package com.plagnito.toulouseville;
import org.junit.Test;
import static org.junit.Assert.*;
import java.time.Instant;
import java.util.*;
public class WalkRulesTest {
    private WalkRules.Fix fix(double lat,double lon,double accuracy,long elapsed){return new WalkRules.Fix(lat,lon,accuracy,elapsed,100000+elapsed);}
    @Test public void jitterAndBadAccuracyDoNotManufactureDistance(){assertEquals(0,WalkRules.segment(fix(43.6,1.44,10,0),fix(43.60001,1.44,10,10000)),.001);assertFalse(WalkRules.reliable(fix(43.6,1.44,100,0)));assertFalse(WalkRules.reliable(fix(Double.NaN,1,5,0)));}
    @Test public void carSpeedGpsJumpsAndSignalGapsResetTheAnchor(){assertEquals(-1,WalkRules.segment(fix(43.6,1.44,5,0),fix(43.61,1.44,5,10000)),0);assertEquals(-1,WalkRules.segment(fix(43.6,1.44,5,0),fix(43.6001,1.44,5,121000)),0);assertEquals(-1,WalkRules.segment(fix(43.6,1.44,5,100),fix(43.6001,1.44,5,50)),0);}
    @Test public void walkingSegmentUsesMeasuredLocations(){double meters=WalkRules.segment(fix(43.6,1.44,5,0),fix(43.6001,1.44,5,10000));assertTrue(meters>11&&meters<12);}
    @Test public void dailyDistanceIsSplitAtParisMidnight(){Map<String,Double> days=WalkRules.splitByDay(Instant.parse("2026-10-01T21:59:50Z").toEpochMilli(),Instant.parse("2026-10-01T22:00:10Z").toEpochMilli(),20);assertEquals(10,days.get("2026-10-01"),.001);assertEquals(10,days.get("2026-10-02"),.001);}
    @Test public void clockChangeDayHasTwentyFiveHours(){Map<String,Double> days=WalkRules.splitByDay(Instant.parse("2026-10-24T22:00:00Z").toEpochMilli(),Instant.parse("2026-10-26T23:00:00Z").toEpochMilli(),49);assertEquals(25,days.get("2026-10-25"),.001);assertEquals(24,days.get("2026-10-26"),.001);}
}
