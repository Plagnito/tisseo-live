package com.plagnito.toulouseville;

/** Rewards depend exclusively on recorded distance. Browsing and route estimates award nothing. */
final class GameRules {
    static long points(double meters){if(!Double.isFinite(meters)||meters<=0)return 0;return (long)Math.floor(meters/100)*10;}
    static long level(long points){return 1+Math.max(0,points)/500;}
    static int progress(long points){return (int)(Math.max(0,points)%500);}
}
