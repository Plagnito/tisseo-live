package com.plagnito.toulouseville;
import android.content.*;
import org.json.*;
import java.util.*;

final class PersonalStore {
    final SharedPreferences prefs;
    PersonalStore(Context context){prefs=context.getSharedPreferences("toulouse-personal",Context.MODE_PRIVATE);}
    JSONObject object(String key){try{return new JSONObject(prefs.getString(key,"{}"));}catch(Exception e){return new JSONObject();}}
    JSONArray array(String key){try{return new JSONArray(prefs.getString(key,"[]"));}catch(Exception e){return new JSONArray();}}
    void put(String key,Object value){prefs.edit().putString(key,value.toString()).apply();}
    List<JSONObject> entries(String key){JSONObject o=object(key);List<JSONObject> result=new ArrayList<>();Iterator<String> keys=o.keys();while(keys.hasNext()){JSONObject value=o.optJSONObject(keys.next());if(value!=null)result.add(value);}result.sort(Comparator.comparing(p->p.optString("name")));return result;}
    boolean contains(String key,String id){return object(key).has(id);}
    void toggle(String key,JSONObject item,String id){JSONObject o=object(key);if(o.has(id))o.remove(id);else if(o.length()<30)try{o.put(id,item);}catch(Exception ignored){}put(key,o);}
    String apiBase(Context context){return context.getSharedPreferences("toulouse-ville",Context.MODE_PRIVATE).getString("api",BuildConfig.API_URL);}
    boolean alertsEnabled(){return prefs.getBoolean("alerts_enabled",false);}
    void enableAlerts(boolean enabled){prefs.edit().putBoolean("alerts_enabled",enabled).putLong("alert_epoch",System.currentTimeMillis()).apply();if(!enabled)prefs.edit().remove("alert_state").apply();}
}
