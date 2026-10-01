package com.plagnito.toulouseville;
import android.content.*;
import org.json.*;
import java.util.*;

final class WalkStore {
    private final PersonalStore store;
    WalkStore(Context c){store=new PersonalStore(c);}
    JSONObject active(){return store.object("active_walk");}
    JSONObject days(){return store.object("walk_days");}
    JSONArray history(){return store.array("walk_history");}
    synchronized void begin(){try{JSONObject session=new JSONObject().put("id",UUID.randomUUID().toString()).put("started_ms",System.currentTimeMillis()).put("last_ms",System.currentTimeMillis()).put("meters",0).put("seconds",0).put("paused",false).put("days",new JSONObject());store.put("active_walk",session);store.prefs.edit().remove("walk_error").apply();}catch(JSONException e){throw new IllegalStateException(e);}}
    synchronized void add(long from,long to,double meters,double seconds){
        JSONObject session=active();if(!session.has("id"))return;JSONObject totals=days(),sessionDays=session.optJSONObject("days");if(sessionDays==null)sessionDays=new JSONObject();
        Map<String,Double> distances=WalkRules.splitByDay(from,to,meters,java.time.ZoneId.systemDefault()),durations=WalkRules.splitByDay(from,to,seconds,java.time.ZoneId.systemDefault());Set<String> keys=new HashSet<>(distances.keySet());keys.addAll(durations.keySet());
        try{for(String date:keys){JSONObject day=totals.optJSONObject(date);if(day==null)day=new JSONObject();JSONObject own=sessionDays.optJSONObject(date);if(own==null)own=new JSONObject();double m=distances.getOrDefault(date,0.0),s=durations.getOrDefault(date,0.0);day.put("meters",day.optDouble("meters",0)+m).put("seconds",day.optDouble("seconds",0)+s);own.put("meters",own.optDouble("meters",0)+m).put("seconds",own.optDouble("seconds",0)+s);totals.put(date,day);sessionDays.put(date,own);}
            session.put("meters",session.optDouble("meters",0)+meters).put("seconds",session.optDouble("seconds",0)+seconds).put("last_ms",to).put("days",sessionDays);store.prefs.edit().putString("walk_days",totals.toString()).putString("active_walk",session.toString()).apply();
        }catch(JSONException e){throw new IllegalStateException(e);}
    }
    synchronized void paused(boolean paused){JSONObject session=active();try{session.put("paused",paused);}catch(JSONException ignored){}store.put("active_walk",session);}
    synchronized void finish(String reason){
        JSONObject session=active();if(!session.has("id"))return;
        try{session.put("status",reason).put("ended_ms",session.optLong("last_ms",session.optLong("started_ms")));JSONArray before=history(),after=new JSONArray().put(session);for(int i=0;i<before.length()&&i<199;i++)after.put(before.get(i));JSONObject totals=days(),own=session.optJSONObject("days");if(own!=null){Iterator<String> dates=own.keys();while(dates.hasNext()){String date=dates.next();JSONObject day=totals.optJSONObject(date);if(day!=null)day.put("sessions",day.optInt("sessions")+1);}}
            store.prefs.edit().putString("walk_history",after.toString()).putString("walk_days",totals.toString()).remove("active_walk").apply();
        }catch(JSONException e){throw new IllegalStateException(e);}
    }
}
