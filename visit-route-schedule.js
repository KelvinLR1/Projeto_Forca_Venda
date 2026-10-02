function addDaysToKey(key,days){const date=new Date(`${key}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10)}

export function generateVisitRouteDates({frequency,visit_date,end_date,weekdays_json='[]',weeks_json='[]'},through=end_date){
  const weekdays=JSON.parse(weekdays_json||'[]'),weeks=JSON.parse(weeks_json||'[]');
  if(frequency==='once')return [visit_date];
  const last=end_date&&(!through||end_date<through)?end_date:(through||end_date);
  if(!last||last<visit_date)return [];
  const output=[];
  if(frequency==='weekly'){
    for(let key=visit_date;key<=last;key=addDaysToKey(key,1))if(weekdays.includes(new Date(`${key}T00:00:00Z`).getUTCDay()))output.push(key);
  }else if(frequency==='monthly'){
    const cursor=new Date(`${visit_date.slice(0,7)}-01T00:00:00Z`),lastDate=new Date(`${last}T00:00:00Z`);
    while(cursor<=lastDate){const year=cursor.getUTCFullYear(),month=cursor.getUTCMonth();for(const week of weeks)for(const weekday of weekdays){const firstDow=new Date(Date.UTC(year,month,1)).getUTCDay(),day=1+((weekday-firstDow+7)%7)+(week-1)*7,date=new Date(Date.UTC(year,month,day));const key=date.toISOString().slice(0,10);if(date.getUTCMonth()===month&&key>=visit_date&&key<=last)output.push(key)}cursor.setUTCMonth(cursor.getUTCMonth()+1)}
  }
  return [...new Set(output)].sort().slice(0,501);
}
