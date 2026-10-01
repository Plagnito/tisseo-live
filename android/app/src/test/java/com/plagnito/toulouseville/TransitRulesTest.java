package com.plagnito.toulouseville;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;
public class TransitRulesTest {
    @Test public void firstSubscriptionIsQuietAndRepeatIsDeduplicated(){Map<String,String> current=Map.of("a","v1");TransitRules.Delta first=TransitRules.changes(null,current,true);assertTrue(first.changed.isEmpty());assertTrue(TransitRules.changes(first.next,current,true).changed.isEmpty());assertEquals(List.of("a"),TransitRules.changes(first.next,Map.of("a","v2"),true).changed);}
    @Test public void quietHoursDeferNewAndChangedAlertsUntilWindow(){TransitRules.Delta night=TransitRules.changes(Map.of("old","v1"),Map.of("old","v2","new","v1"),false);assertTrue(night.changed.isEmpty());assertEquals("v1",night.next.get("old"));assertFalse(night.next.containsKey("new"));assertEquals(2,TransitRules.changes(night.next,Map.of("old","v2","new","v1"),true).changed.size());}
    @Test public void resolvedAlertsAreRemovedAndPeriodsAreRespected(){assertTrue(TransitRules.changes(Map.of("gone","x"),Map.of(),true).next.isEmpty());assertFalse(TransitRules.active(100,List.of(new long[]{101,200})));assertTrue(TransitRules.active(100,List.of(new long[]{0,200})));assertFalse(TransitRules.active(200,List.of(new long[]{0,200})));assertTrue(TransitRules.active(100,List.of()));}
    @Test public void staleOrFutureFluxCannotTriggerNotifications(){assertFalse(TransitRules.fresh(1,1000));assertFalse(TransitRules.fresh(1100,1000));assertTrue(TransitRules.fresh(995,1000));assertFalse(TransitRules.fresh(0,1000));}
    @Test public void overnightWindowAndFingerprintOrderAreStable(){assertTrue(TransitRules.withinHours(23,22,7));assertFalse(TransitRules.withinHours(12,22,7));assertFalse(TransitRules.withinHours(22,8,22));assertEquals(TransitRules.fingerprint("A  B","C","",1,List.of("1-2","3-4")),TransitRules.fingerprint("A B","C","",1,List.of("3-4","1-2")));}
}
