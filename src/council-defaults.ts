export interface CouncilDefaults {
  pitch:'Stepney Green Park (Artificial)';openingHours:'Mon - Fri 10am - 9pm (10pm closing)';resident:'No';changingRooms:'No';size:'Third';teamCategory:'Senior (16 or Over)';teamName:string;
}
export function parseCouncilDefaults(input:unknown):CouncilDefaults {
  if(!input || typeof input!=='object')throw new Error('Council默认选项无效');
  const data=input as Record<string,unknown>;
  const fixed={pitch:'Stepney Green Park (Artificial)',openingHours:'Mon - Fri 10am - 9pm (10pm closing)',resident:'No',changingRooms:'No',size:'Third',teamCategory:'Senior (16 or Over)'} as const;
  if(Object.entries(fixed).some(([key,value])=>data[key]!==value) || typeof data.teamName!=='string' || !data.teamName.trim() || data.teamName.length>100)throw new Error('Council默认选项无效');
  return {...fixed,teamName:data.teamName.trim()};
}
