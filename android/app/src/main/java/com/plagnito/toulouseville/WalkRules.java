package com.plagnito.toulouseville;

import java.time.*;
import java.util.*;

final class WalkRules {
    static final class Fix {
        final double lat,lon,accuracy; final long elapsedMs,wallMs;
        Fix(double lat,double lon,double accuracy,long elapsedMs,long wallMs){this.lat=lat;this.lon=lon;this.accuracy=accuracy;this.elapsedMs=elapsedMs;this.wallMs=wallMs;}
    }
    static boolean reliable(Fix fix){return Double.isFinite(fix.lat+fix.lon+fix.accuracy)&&Math.abs(fix.lat)<=90&&Math.abs(fix.lon)<=180&&fix.accuracy>0&&fix.accuracy<=35;}
    /** -1 resets the anchor after a gap/jump; zero filters stationary jitter. */
    static double segment(Fix a,Fix b){
        if(!reliable(a)||!reliable(b))return -1;
        long dt=b.elapsedMs-a.elapsedMs;
        if(dt<=0||dt>120000||b.wallMs<=a.wallMs)return -1;
        double distance=GeoRules.distance(a.lat,a.lon,b.lat,b.lon);
        if(distance/(dt/1000.0)>3.2)return -1;
        return distance<Math.max(5,Math.min(20,(a.accuracy+b.accuracy)/2))?0:distance;
    }
    static Map<String,Double> splitByDay(long from,long to,double amount){
        return splitByDay(from,to,amount,GeoRules.PARIS);
    }
    static Map<String,Double> splitByDay(long from,long to,double amount,ZoneId zone){
        Map<String,Double> result=new LinkedHashMap<>();if(to<=from||!Double.isFinite(amount)||amount<0)return result;
        long cursor=from;
        while(cursor<to){ZonedDateTime time=Instant.ofEpochMilli(cursor).atZone(zone);long next=Math.min(to,time.toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli());result.merge(time.toLocalDate().toString(),amount*(next-cursor)/(to-from),Double::sum);cursor=next;}
        return result;
    }
}
