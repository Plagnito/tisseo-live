package com.plagnito.toulouseville;
import org.junit.Test;
import static org.junit.Assert.*;
public class GameRulesTest {
    @Test public void onlyCompleteHundredMetersGivePoints(){assertEquals(0,GameRules.points(99.9));assertEquals(10,GameRules.points(100));assertEquals(100,GameRules.points(1000));assertEquals(0,GameRules.points(Double.NaN));assertEquals(0,GameRules.points(-20));}
    @Test public void levelsUseStableDistanceThresholds(){assertEquals(1,GameRules.level(499));assertEquals(2,GameRules.level(500));assertEquals(0,GameRules.progress(500));assertEquals(10,GameRules.progress(510));}
}
