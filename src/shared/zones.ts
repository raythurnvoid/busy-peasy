// Windows zone names that Outlook takes, each with the IANA zones that use it, and each zone's country. From CLDR
// windowsZones.xml, the whole table:
// https://github.com/unicode-org/cldr/blob/c4bb2c199c5385088f52011c4d4c813f2c36db1e/common/supplemental/windowsZones.xml
// Made once with a script that is not in the repo. To make it again: for each Windows name, the first IANA zone is
// CLDR's main one (territory 001), then the ids of the other rows, without empty ids. Leave out the ids whose clock is not
// the main zone's in Electron or in Node (zones.test.ts checks this), so the app does not send them to Outlook: today
// America/Inuvik, America/Scoresbysund, Antarctica/Casey and Antarctica/Vostok. COUNTRIES takes each row's territory,
// without the rows of no country ('ZZ').
// UTC and Europe/Kyiv are not in CLDR's rows, but ICU may report them.
// prettier-ignore
export const ZONES: Record<string, string[]> = {
  'Dateline Standard Time': ['Etc/GMT+12'],
  'UTC-11': ['Etc/GMT+11', 'Pacific/Pago_Pago', 'Pacific/Niue', 'Pacific/Midway'],
  'Aleutian Standard Time': ['America/Adak'],
  'Hawaiian Standard Time': ['Pacific/Honolulu', 'Pacific/Rarotonga', 'Pacific/Tahiti', 'Etc/GMT+10'],
  'Marquesas Standard Time': ['Pacific/Marquesas'],
  'Alaskan Standard Time': ['America/Anchorage', 'America/Juneau', 'America/Metlakatla', 'America/Nome', 'America/Sitka', 'America/Yakutat'],
  'UTC-09': ['Etc/GMT+9', 'Pacific/Gambier'],
  'Pacific Standard Time (Mexico)': ['America/Tijuana'],
  'UTC-08': ['Etc/GMT+8', 'Pacific/Pitcairn'],
  'Pacific Standard Time': ['America/Los_Angeles'],
  'US Mountain Standard Time': ['America/Phoenix', 'America/Creston', 'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Hermosillo',
    'Etc/GMT+7'],
  'Mountain Standard Time (Mexico)': ['America/Mazatlan'],
  'Mountain Standard Time': ['America/Denver', 'America/Cambridge_Bay', 'America/Ciudad_Juarez', 'America/Boise'],
  'British Columbia Standard Time': ['America/Vancouver'],
  'Yukon Standard Time': ['America/Whitehorse', 'America/Dawson'],
  'Alberta Standard Time': ['America/Edmonton'],
  'Central America Standard Time': ['America/Guatemala', 'America/Belize', 'America/Costa_Rica', 'Pacific/Galapagos', 'America/Tegucigalpa',
    'America/Managua', 'America/El_Salvador', 'Etc/GMT+6'],
  'Central Standard Time': ['America/Chicago', 'America/Rankin_Inlet', 'America/Resolute', 'America/Matamoros', 'America/Ojinaga',
    'America/Indiana/Knox', 'America/Indiana/Tell_City', 'America/Menominee', 'America/North_Dakota/Beulah',
    'America/North_Dakota/Center', 'America/North_Dakota/New_Salem'],
  'Easter Island Standard Time': ['Pacific/Easter'],
  'Central Standard Time (Mexico)': ['America/Mexico_City', 'America/Bahia_Banderas', 'America/Merida', 'America/Monterrey', 'America/Chihuahua'],
  'Canada Central Standard Time': ['America/Regina', 'America/Swift_Current'],
  'Manitoba Standard Time': ['America/Winnipeg'],
  'SA Pacific Standard Time': ['America/Bogota', 'America/Rio_Branco', 'America/Eirunepe', 'America/Coral_Harbour', 'America/Guayaquil',
    'America/Jamaica', 'America/Cayman', 'America/Panama', 'America/Lima', 'Etc/GMT+5'],
  'Eastern Standard Time (Mexico)': ['America/Cancun'],
  'Eastern Standard Time': ['America/New_York', 'America/Nassau', 'America/Toronto', 'America/Iqaluit', 'America/Detroit',
    'America/Indiana/Petersburg', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Kentucky/Monticello',
    'America/Louisville'],
  'Haiti Standard Time': ['America/Port-au-Prince'],
  'Cuba Standard Time': ['America/Havana'],
  'US Eastern Standard Time': ['America/Indianapolis', 'America/Indiana/Marengo', 'America/Indiana/Vevay'],
  'Turks And Caicos Standard Time': ['America/Grand_Turk'],
  'Paraguay Standard Time': ['America/Asuncion'],
  'Atlantic Standard Time': ['America/Halifax', 'Atlantic/Bermuda', 'America/Glace_Bay', 'America/Goose_Bay', 'America/Moncton', 'America/Thule'],
  'Venezuela Standard Time': ['America/Caracas'],
  'Central Brazilian Standard Time': ['America/Cuiaba', 'America/Campo_Grande'],
  'SA Western Standard Time': ['America/La_Paz', 'America/Antigua', 'America/Anguilla', 'America/Aruba', 'America/Barbados',
    'America/St_Barthelemy', 'America/Kralendijk', 'America/Manaus', 'America/Boa_Vista', 'America/Porto_Velho',
    'America/Blanc-Sablon', 'America/Curacao', 'America/Dominica', 'America/Santo_Domingo', 'America/Grenada',
    'America/Guadeloupe', 'America/Guyana', 'America/St_Kitts', 'America/St_Lucia', 'America/Marigot',
    'America/Martinique', 'America/Montserrat', 'America/Puerto_Rico', 'America/Lower_Princes', 'America/Port_of_Spain',
    'America/St_Vincent', 'America/Tortola', 'America/St_Thomas', 'Etc/GMT+4'],
  'Pacific SA Standard Time': ['America/Santiago'],
  'Newfoundland Standard Time': ['America/St_Johns'],
  'Tocantins Standard Time': ['America/Araguaina'],
  'E. South America Standard Time': ['America/Sao_Paulo'],
  'SA Eastern Standard Time': ['America/Cayenne', 'Antarctica/Rothera', 'Antarctica/Palmer', 'America/Fortaleza', 'America/Belem',
    'America/Maceio', 'America/Recife', 'America/Santarem', 'Atlantic/Stanley', 'America/Paramaribo', 'Etc/GMT+3'],
  'Argentina Standard Time': ['America/Buenos_Aires', 'America/Argentina/La_Rioja', 'America/Argentina/Rio_Gallegos', 'America/Argentina/Salta',
    'America/Argentina/San_Juan', 'America/Argentina/San_Luis', 'America/Argentina/Tucuman',
    'America/Argentina/Ushuaia', 'America/Catamarca', 'America/Cordoba', 'America/Jujuy', 'America/Mendoza'],
  'Greenland Standard Time': ['America/Godthab'],
  'Montevideo Standard Time': ['America/Montevideo'],
  'Magallanes Standard Time': ['America/Punta_Arenas', 'America/Coyhaique'],
  'Saint Pierre Standard Time': ['America/Miquelon'],
  'Bahia Standard Time': ['America/Bahia'],
  'UTC-02': ['Etc/GMT+2', 'America/Noronha', 'Atlantic/South_Georgia'],
  'Azores Standard Time': ['Atlantic/Azores'],
  'Cape Verde Standard Time': ['Atlantic/Cape_Verde', 'Etc/GMT+1'],
  UTC: ['Etc/UTC', 'UTC', 'Etc/GMT'],
  'GMT Standard Time': ['Europe/London', 'Atlantic/Canary', 'Atlantic/Faeroe', 'Europe/Guernsey', 'Europe/Dublin', 'Europe/Isle_of_Man',
    'Europe/Jersey', 'Europe/Lisbon', 'Atlantic/Madeira'],
  'Greenwich Standard Time': ['Atlantic/Reykjavik', 'Africa/Ouagadougou', 'Africa/Abidjan', 'Africa/Accra', 'America/Danmarkshavn',
    'Africa/Banjul', 'Africa/Conakry', 'Africa/Bissau', 'Africa/Monrovia', 'Africa/Bamako', 'Africa/Nouakchott',
    'Atlantic/St_Helena', 'Africa/Freetown', 'Africa/Dakar', 'Africa/Lome'],
  'Sao Tome Standard Time': ['Africa/Sao_Tome'],
  'Morocco Standard Time': ['Africa/Casablanca', 'Africa/El_Aaiun'],
  'W. Europe Standard Time': ['Europe/Berlin', 'Europe/Andorra', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Busingen', 'Europe/Gibraltar',
    'Europe/Rome', 'Europe/Vaduz', 'Europe/Luxembourg', 'Europe/Monaco', 'Europe/Malta', 'Europe/Amsterdam',
    'Europe/Oslo', 'Europe/Stockholm', 'Arctic/Longyearbyen', 'Europe/San_Marino', 'Europe/Vatican'],
  'Central Europe Standard Time': ['Europe/Budapest', 'Europe/Tirane', 'Europe/Prague', 'Europe/Podgorica', 'Europe/Belgrade', 'Europe/Ljubljana',
    'Europe/Bratislava'],
  'Romance Standard Time': ['Europe/Paris', 'Europe/Brussels', 'Europe/Copenhagen', 'Europe/Madrid', 'Africa/Ceuta'],
  'Central European Standard Time': ['Europe/Warsaw', 'Europe/Sarajevo', 'Europe/Zagreb', 'Europe/Skopje'],
  'W. Central Africa Standard Time': ['Africa/Lagos', 'Africa/Luanda', 'Africa/Porto-Novo', 'Africa/Kinshasa', 'Africa/Bangui', 'Africa/Brazzaville',
    'Africa/Douala', 'Africa/Algiers', 'Africa/Libreville', 'Africa/Malabo', 'Africa/Niamey', 'Africa/Ndjamena',
    'Africa/Tunis', 'Etc/GMT-1'],
  'Jordan Standard Time': ['Asia/Amman'],
  'GTB Standard Time': ['Europe/Bucharest', 'Asia/Nicosia', 'Asia/Famagusta', 'Europe/Athens'],
  'Middle East Standard Time': ['Asia/Beirut'],
  'Egypt Standard Time': ['Africa/Cairo'],
  'E. Europe Standard Time': ['Europe/Chisinau'],
  'Syria Standard Time': ['Asia/Damascus'],
  'West Bank Standard Time': ['Asia/Hebron', 'Asia/Gaza'],
  'South Africa Standard Time': ['Africa/Johannesburg', 'Africa/Bujumbura', 'Africa/Gaborone', 'Africa/Lubumbashi', 'Africa/Maseru',
    'Africa/Blantyre', 'Africa/Maputo', 'Africa/Kigali', 'Africa/Mbabane', 'Africa/Lusaka', 'Africa/Harare', 'Etc/GMT-2'],
  'FLE Standard Time': ['Europe/Kiev', 'Europe/Kyiv', 'Europe/Mariehamn', 'Europe/Sofia', 'Europe/Tallinn', 'Europe/Helsinki',
    'Europe/Vilnius', 'Europe/Riga'],
  'Israel Standard Time': ['Asia/Jerusalem'],
  'South Sudan Standard Time': ['Africa/Juba'],
  'Kaliningrad Standard Time': ['Europe/Kaliningrad'],
  'Sudan Standard Time': ['Africa/Khartoum'],
  'Libya Standard Time': ['Africa/Tripoli'],
  'Namibia Standard Time': ['Africa/Windhoek'],
  'Arabic Standard Time': ['Asia/Baghdad'],
  'Turkey Standard Time': ['Europe/Istanbul'],
  'Arab Standard Time': ['Asia/Riyadh', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Aden'],
  'Belarus Standard Time': ['Europe/Minsk'],
  'Russian Standard Time': ['Europe/Moscow', 'Europe/Kirov', 'Europe/Simferopol'],
  'E. Africa Standard Time': ['Africa/Nairobi', 'Antarctica/Syowa', 'Africa/Djibouti', 'Africa/Asmera', 'Africa/Addis_Ababa', 'Indian/Comoro',
    'Indian/Antananarivo', 'Africa/Mogadishu', 'Africa/Dar_es_Salaam', 'Africa/Kampala', 'Indian/Mayotte', 'Etc/GMT-3'],
  'Iran Standard Time': ['Asia/Tehran'],
  'Arabian Standard Time': ['Asia/Dubai', 'Asia/Muscat', 'Etc/GMT-4'],
  'Astrakhan Standard Time': ['Europe/Astrakhan', 'Europe/Ulyanovsk'],
  'Azerbaijan Standard Time': ['Asia/Baku'],
  'Russia Time Zone 3': ['Europe/Samara'],
  'Mauritius Standard Time': ['Indian/Mauritius', 'Indian/Reunion', 'Indian/Mahe'],
  'Saratov Standard Time': ['Europe/Saratov'],
  'Georgian Standard Time': ['Asia/Tbilisi'],
  'Volgograd Standard Time': ['Europe/Volgograd'],
  'Caucasus Standard Time': ['Asia/Yerevan'],
  'Afghanistan Standard Time': ['Asia/Kabul'],
  'West Asia Standard Time': ['Asia/Tashkent', 'Antarctica/Mawson', 'Asia/Oral', 'Asia/Almaty', 'Asia/Aqtau', 'Asia/Aqtobe', 'Asia/Atyrau',
    'Asia/Qostanay', 'Indian/Maldives', 'Indian/Kerguelen', 'Asia/Dushanbe', 'Asia/Ashgabat', 'Asia/Samarkand',
    'Etc/GMT-5'],
  'Ekaterinburg Standard Time': ['Asia/Yekaterinburg'],
  'Pakistan Standard Time': ['Asia/Karachi'],
  'Qyzylorda Standard Time': ['Asia/Qyzylorda'],
  'India Standard Time': ['Asia/Calcutta'],
  'Sri Lanka Standard Time': ['Asia/Colombo'],
  'Nepal Standard Time': ['Asia/Katmandu'],
  'Central Asia Standard Time': ['Asia/Bishkek', 'Asia/Urumqi', 'Indian/Chagos', 'Etc/GMT-6'],
  'Bangladesh Standard Time': ['Asia/Dhaka', 'Asia/Thimphu'],
  'Omsk Standard Time': ['Asia/Omsk'],
  'Myanmar Standard Time': ['Asia/Rangoon', 'Indian/Cocos'],
  'SE Asia Standard Time': ['Asia/Bangkok', 'Antarctica/Davis', 'Indian/Christmas', 'Asia/Jakarta', 'Asia/Pontianak', 'Asia/Phnom_Penh',
    'Asia/Vientiane', 'Asia/Saigon', 'Etc/GMT-7'],
  'Altai Standard Time': ['Asia/Barnaul'],
  'W. Mongolia Standard Time': ['Asia/Hovd'],
  'North Asia Standard Time': ['Asia/Krasnoyarsk', 'Asia/Novokuznetsk'],
  'N. Central Asia Standard Time': ['Asia/Novosibirsk'],
  'Tomsk Standard Time': ['Asia/Tomsk'],
  'China Standard Time': ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Macau'],
  'North Asia East Standard Time': ['Asia/Irkutsk'],
  'Singapore Standard Time': ['Asia/Singapore', 'Asia/Brunei', 'Asia/Makassar', 'Asia/Kuala_Lumpur', 'Asia/Kuching', 'Asia/Manila', 'Etc/GMT-8'],
  'W. Australia Standard Time': ['Australia/Perth'],
  'Taipei Standard Time': ['Asia/Taipei'],
  'Ulaanbaatar Standard Time': ['Asia/Ulaanbaatar'],
  'Aus Central W. Standard Time': ['Australia/Eucla'],
  'Transbaikal Standard Time': ['Asia/Chita'],
  'Tokyo Standard Time': ['Asia/Tokyo', 'Asia/Jayapura', 'Pacific/Palau', 'Asia/Dili', 'Etc/GMT-9'],
  'North Korea Standard Time': ['Asia/Pyongyang'],
  'Korea Standard Time': ['Asia/Seoul'],
  'Yakutsk Standard Time': ['Asia/Yakutsk', 'Asia/Khandyga'],
  'Cen. Australia Standard Time': ['Australia/Adelaide', 'Australia/Broken_Hill'],
  'AUS Central Standard Time': ['Australia/Darwin'],
  'E. Australia Standard Time': ['Australia/Brisbane', 'Australia/Lindeman'],
  'AUS Eastern Standard Time': ['Australia/Sydney', 'Australia/Melbourne'],
  'West Pacific Standard Time': ['Pacific/Port_Moresby', 'Antarctica/DumontDUrville', 'Pacific/Truk', 'Pacific/Guam', 'Pacific/Saipan', 'Etc/GMT-10'],
  'Tasmania Standard Time': ['Australia/Hobart', 'Antarctica/Macquarie'],
  'Vladivostok Standard Time': ['Asia/Vladivostok', 'Asia/Ust-Nera'],
  'Lord Howe Standard Time': ['Australia/Lord_Howe'],
  'Bougainville Standard Time': ['Pacific/Bougainville'],
  'Russia Time Zone 10': ['Asia/Srednekolymsk'],
  'Magadan Standard Time': ['Asia/Magadan'],
  'Norfolk Standard Time': ['Pacific/Norfolk'],
  'Sakhalin Standard Time': ['Asia/Sakhalin'],
  'Central Pacific Standard Time': ['Pacific/Guadalcanal', 'Pacific/Ponape', 'Pacific/Kosrae', 'Pacific/Noumea', 'Pacific/Efate', 'Etc/GMT-11'],
  'Russia Time Zone 11': ['Asia/Kamchatka', 'Asia/Anadyr'],
  'New Zealand Standard Time': ['Pacific/Auckland', 'Antarctica/McMurdo'],
  'UTC+12': ['Etc/GMT-12', 'Pacific/Tarawa', 'Pacific/Majuro', 'Pacific/Kwajalein', 'Pacific/Nauru', 'Pacific/Funafuti',
    'Pacific/Wake', 'Pacific/Wallis'],
  'Fiji Standard Time': ['Pacific/Fiji'],
  'Chatham Islands Standard Time': ['Pacific/Chatham'],
  'UTC+13': ['Etc/GMT-13', 'Pacific/Enderbury', 'Pacific/Fakaofo'],
  'Tonga Standard Time': ['Pacific/Tongatapu'],
  'Samoa Standard Time': ['Pacific/Apia'],
  'Line Islands Standard Time': ['Pacific/Kiritimati', 'Etc/GMT-14']
}

// IANA zone -> ISO country code, for the country search of the zone picker.
// prettier-ignore
export const COUNTRIES: Record<string, string> = {
  'Africa/Abidjan': 'CI', 'Africa/Accra': 'GH', 'Africa/Addis_Ababa': 'ET', 'Africa/Algiers': 'DZ',
  'Africa/Asmera': 'ER', 'Africa/Bamako': 'ML', 'Africa/Bangui': 'CF', 'Africa/Banjul': 'GM', 'Africa/Bissau': 'GW',
  'Africa/Blantyre': 'MW', 'Africa/Brazzaville': 'CG', 'Africa/Bujumbura': 'BI', 'Africa/Cairo': 'EG',
  'Africa/Casablanca': 'MA', 'Africa/Ceuta': 'ES', 'Africa/Conakry': 'GN', 'Africa/Dakar': 'SN',
  'Africa/Dar_es_Salaam': 'TZ', 'Africa/Djibouti': 'DJ', 'Africa/Douala': 'CM', 'Africa/El_Aaiun': 'EH',
  'Africa/Freetown': 'SL', 'Africa/Gaborone': 'BW', 'Africa/Harare': 'ZW', 'Africa/Johannesburg': 'ZA',
  'Africa/Juba': 'SS', 'Africa/Kampala': 'UG', 'Africa/Khartoum': 'SD', 'Africa/Kigali': 'RW', 'Africa/Kinshasa': 'CD',
  'Africa/Lagos': 'NG', 'Africa/Libreville': 'GA', 'Africa/Lome': 'TG', 'Africa/Luanda': 'AO',
  'Africa/Lubumbashi': 'CD', 'Africa/Lusaka': 'ZM', 'Africa/Malabo': 'GQ', 'Africa/Maputo': 'MZ',
  'Africa/Maseru': 'LS', 'Africa/Mbabane': 'SZ', 'Africa/Mogadishu': 'SO', 'Africa/Monrovia': 'LR',
  'Africa/Nairobi': 'KE', 'Africa/Ndjamena': 'TD', 'Africa/Niamey': 'NE', 'Africa/Nouakchott': 'MR',
  'Africa/Ouagadougou': 'BF', 'Africa/Porto-Novo': 'BJ', 'Africa/Sao_Tome': 'ST', 'Africa/Tripoli': 'LY',
  'Africa/Tunis': 'TN', 'Africa/Windhoek': 'NA', 'America/Adak': 'US', 'America/Anchorage': 'US',
  'America/Anguilla': 'AI', 'America/Antigua': 'AG', 'America/Araguaina': 'BR', 'America/Argentina/La_Rioja': 'AR',
  'America/Argentina/Rio_Gallegos': 'AR', 'America/Argentina/Salta': 'AR', 'America/Argentina/San_Juan': 'AR',
  'America/Argentina/San_Luis': 'AR', 'America/Argentina/Tucuman': 'AR', 'America/Argentina/Ushuaia': 'AR',
  'America/Aruba': 'AW', 'America/Asuncion': 'PY', 'America/Bahia': 'BR', 'America/Bahia_Banderas': 'MX',
  'America/Barbados': 'BB', 'America/Belem': 'BR', 'America/Belize': 'BZ', 'America/Blanc-Sablon': 'CA',
  'America/Boa_Vista': 'BR', 'America/Bogota': 'CO', 'America/Boise': 'US', 'America/Buenos_Aires': 'AR',
  'America/Cambridge_Bay': 'CA', 'America/Campo_Grande': 'BR', 'America/Cancun': 'MX', 'America/Caracas': 'VE',
  'America/Catamarca': 'AR', 'America/Cayenne': 'GF', 'America/Cayman': 'KY', 'America/Chicago': 'US',
  'America/Chihuahua': 'MX', 'America/Ciudad_Juarez': 'MX', 'America/Coral_Harbour': 'CA', 'America/Cordoba': 'AR',
  'America/Costa_Rica': 'CR', 'America/Coyhaique': 'CL', 'America/Creston': 'CA', 'America/Cuiaba': 'BR',
  'America/Curacao': 'CW', 'America/Danmarkshavn': 'GL', 'America/Dawson': 'CA', 'America/Dawson_Creek': 'CA',
  'America/Denver': 'US', 'America/Detroit': 'US', 'America/Dominica': 'DM', 'America/Edmonton': 'CA',
  'America/Eirunepe': 'BR', 'America/El_Salvador': 'SV', 'America/Fort_Nelson': 'CA', 'America/Fortaleza': 'BR',
  'America/Glace_Bay': 'CA', 'America/Godthab': 'GL', 'America/Goose_Bay': 'CA', 'America/Grand_Turk': 'TC',
  'America/Grenada': 'GD', 'America/Guadeloupe': 'GP', 'America/Guatemala': 'GT', 'America/Guayaquil': 'EC',
  'America/Guyana': 'GY', 'America/Halifax': 'CA', 'America/Havana': 'CU', 'America/Hermosillo': 'MX',
  'America/Indiana/Knox': 'US', 'America/Indiana/Marengo': 'US', 'America/Indiana/Petersburg': 'US',
  'America/Indiana/Tell_City': 'US', 'America/Indiana/Vevay': 'US', 'America/Indiana/Vincennes': 'US',
  'America/Indiana/Winamac': 'US', 'America/Indianapolis': 'US', 'America/Inuvik': 'CA', 'America/Iqaluit': 'CA',
  'America/Jamaica': 'JM', 'America/Jujuy': 'AR', 'America/Juneau': 'US', 'America/Kentucky/Monticello': 'US',
  'America/Kralendijk': 'BQ', 'America/La_Paz': 'BO', 'America/Lima': 'PE', 'America/Los_Angeles': 'US',
  'America/Louisville': 'US', 'America/Lower_Princes': 'SX', 'America/Maceio': 'BR', 'America/Managua': 'NI',
  'America/Manaus': 'BR', 'America/Marigot': 'MF', 'America/Martinique': 'MQ', 'America/Matamoros': 'MX',
  'America/Mazatlan': 'MX', 'America/Mendoza': 'AR', 'America/Menominee': 'US', 'America/Merida': 'MX',
  'America/Metlakatla': 'US', 'America/Mexico_City': 'MX', 'America/Miquelon': 'PM', 'America/Moncton': 'CA',
  'America/Monterrey': 'MX', 'America/Montevideo': 'UY', 'America/Montserrat': 'MS', 'America/Nassau': 'BS',
  'America/New_York': 'US', 'America/Nome': 'US', 'America/Noronha': 'BR', 'America/North_Dakota/Beulah': 'US',
  'America/North_Dakota/Center': 'US', 'America/North_Dakota/New_Salem': 'US', 'America/Ojinaga': 'MX',
  'America/Panama': 'PA', 'America/Paramaribo': 'SR', 'America/Phoenix': 'US', 'America/Port_of_Spain': 'TT',
  'America/Port-au-Prince': 'HT', 'America/Porto_Velho': 'BR', 'America/Puerto_Rico': 'PR',
  'America/Punta_Arenas': 'CL', 'America/Rankin_Inlet': 'CA', 'America/Recife': 'BR', 'America/Regina': 'CA',
  'America/Resolute': 'CA', 'America/Rio_Branco': 'BR', 'America/Santarem': 'BR', 'America/Santiago': 'CL',
  'America/Santo_Domingo': 'DO', 'America/Sao_Paulo': 'BR', 'America/Scoresbysund': 'GL', 'America/Sitka': 'US',
  'America/St_Barthelemy': 'BL', 'America/St_Johns': 'CA', 'America/St_Kitts': 'KN', 'America/St_Lucia': 'LC',
  'America/St_Thomas': 'VI', 'America/St_Vincent': 'VC', 'America/Swift_Current': 'CA', 'America/Tegucigalpa': 'HN',
  'America/Thule': 'GL', 'America/Tijuana': 'MX', 'America/Toronto': 'CA', 'America/Tortola': 'VG',
  'America/Vancouver': 'CA', 'America/Whitehorse': 'CA', 'America/Winnipeg': 'CA', 'America/Yakutat': 'US',
  'Antarctica/Casey': 'AQ', 'Antarctica/Davis': 'AQ', 'Antarctica/DumontDUrville': 'AQ', 'Antarctica/Macquarie': 'AU',
  'Antarctica/Mawson': 'AQ', 'Antarctica/McMurdo': 'AQ', 'Antarctica/Palmer': 'AQ', 'Antarctica/Rothera': 'AQ',
  'Antarctica/Syowa': 'AQ', 'Antarctica/Vostok': 'AQ', 'Arctic/Longyearbyen': 'SJ', 'Asia/Aden': 'YE',
  'Asia/Almaty': 'KZ', 'Asia/Amman': 'JO', 'Asia/Anadyr': 'RU', 'Asia/Aqtau': 'KZ', 'Asia/Aqtobe': 'KZ',
  'Asia/Ashgabat': 'TM', 'Asia/Atyrau': 'KZ', 'Asia/Baghdad': 'IQ', 'Asia/Bahrain': 'BH', 'Asia/Baku': 'AZ',
  'Asia/Bangkok': 'TH', 'Asia/Barnaul': 'RU', 'Asia/Beirut': 'LB', 'Asia/Bishkek': 'KG', 'Asia/Brunei': 'BN',
  'Asia/Calcutta': 'IN', 'Asia/Chita': 'RU', 'Asia/Colombo': 'LK', 'Asia/Damascus': 'SY', 'Asia/Dhaka': 'BD',
  'Asia/Dili': 'TL', 'Asia/Dubai': 'AE', 'Asia/Dushanbe': 'TJ', 'Asia/Famagusta': 'CY', 'Asia/Gaza': 'PS',
  'Asia/Hebron': 'PS', 'Asia/Hong_Kong': 'HK', 'Asia/Hovd': 'MN', 'Asia/Irkutsk': 'RU', 'Asia/Jakarta': 'ID',
  'Asia/Jayapura': 'ID', 'Asia/Jerusalem': 'IL', 'Asia/Kabul': 'AF', 'Asia/Kamchatka': 'RU', 'Asia/Karachi': 'PK',
  'Asia/Katmandu': 'NP', 'Asia/Khandyga': 'RU', 'Asia/Krasnoyarsk': 'RU', 'Asia/Kuala_Lumpur': 'MY',
  'Asia/Kuching': 'MY', 'Asia/Kuwait': 'KW', 'Asia/Macau': 'MO', 'Asia/Magadan': 'RU', 'Asia/Makassar': 'ID',
  'Asia/Manila': 'PH', 'Asia/Muscat': 'OM', 'Asia/Nicosia': 'CY', 'Asia/Novokuznetsk': 'RU', 'Asia/Novosibirsk': 'RU',
  'Asia/Omsk': 'RU', 'Asia/Oral': 'KZ', 'Asia/Phnom_Penh': 'KH', 'Asia/Pontianak': 'ID', 'Asia/Pyongyang': 'KP',
  'Asia/Qatar': 'QA', 'Asia/Qostanay': 'KZ', 'Asia/Qyzylorda': 'KZ', 'Asia/Rangoon': 'MM', 'Asia/Riyadh': 'SA',
  'Asia/Saigon': 'VN', 'Asia/Sakhalin': 'RU', 'Asia/Samarkand': 'UZ', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN',
  'Asia/Singapore': 'SG', 'Asia/Srednekolymsk': 'RU', 'Asia/Taipei': 'TW', 'Asia/Tashkent': 'UZ', 'Asia/Tbilisi': 'GE',
  'Asia/Tehran': 'IR', 'Asia/Thimphu': 'BT', 'Asia/Tokyo': 'JP', 'Asia/Tomsk': 'RU', 'Asia/Ulaanbaatar': 'MN',
  'Asia/Urumqi': 'CN', 'Asia/Ust-Nera': 'RU', 'Asia/Vientiane': 'LA', 'Asia/Vladivostok': 'RU', 'Asia/Yakutsk': 'RU',
  'Asia/Yekaterinburg': 'RU', 'Asia/Yerevan': 'AM', 'Atlantic/Azores': 'PT', 'Atlantic/Bermuda': 'BM',
  'Atlantic/Canary': 'ES', 'Atlantic/Cape_Verde': 'CV', 'Atlantic/Faeroe': 'FO', 'Atlantic/Madeira': 'PT',
  'Atlantic/Reykjavik': 'IS', 'Atlantic/South_Georgia': 'GS', 'Atlantic/St_Helena': 'SH', 'Atlantic/Stanley': 'FK',
  'Australia/Adelaide': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Broken_Hill': 'AU', 'Australia/Darwin': 'AU',
  'Australia/Eucla': 'AU', 'Australia/Hobart': 'AU', 'Australia/Lindeman': 'AU', 'Australia/Lord_Howe': 'AU',
  'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU', 'Australia/Sydney': 'AU', 'Europe/Amsterdam': 'NL', 'Europe/Andorra': 'AD',
  'Europe/Astrakhan': 'RU', 'Europe/Athens': 'GR', 'Europe/Belgrade': 'RS', 'Europe/Berlin': 'DE',
  'Europe/Bratislava': 'SK', 'Europe/Brussels': 'BE', 'Europe/Bucharest': 'RO', 'Europe/Budapest': 'HU',
  'Europe/Busingen': 'DE', 'Europe/Chisinau': 'MD', 'Europe/Copenhagen': 'DK', 'Europe/Dublin': 'IE',
  'Europe/Gibraltar': 'GI', 'Europe/Guernsey': 'GG', 'Europe/Helsinki': 'FI', 'Europe/Isle_of_Man': 'IM',
  'Europe/Istanbul': 'TR', 'Europe/Jersey': 'JE', 'Europe/Kaliningrad': 'RU', 'Europe/Kiev': 'UA',
  'Europe/Kirov': 'RU', 'Europe/Lisbon': 'PT', 'Europe/Ljubljana': 'SI', 'Europe/London': 'GB',
  'Europe/Luxembourg': 'LU', 'Europe/Madrid': 'ES', 'Europe/Malta': 'MT', 'Europe/Mariehamn': 'AX',
  'Europe/Minsk': 'BY', 'Europe/Monaco': 'MC', 'Europe/Moscow': 'RU', 'Europe/Oslo': 'NO', 'Europe/Paris': 'FR',
  'Europe/Podgorica': 'ME', 'Europe/Prague': 'CZ', 'Europe/Riga': 'LV', 'Europe/Rome': 'IT', 'Europe/Samara': 'RU',
  'Europe/San_Marino': 'SM', 'Europe/Sarajevo': 'BA', 'Europe/Saratov': 'RU', 'Europe/Simferopol': 'UA',
  'Europe/Skopje': 'MK', 'Europe/Sofia': 'BG', 'Europe/Stockholm': 'SE', 'Europe/Tallinn': 'EE', 'Europe/Tirane': 'AL',
  'Europe/Ulyanovsk': 'RU', 'Europe/Vaduz': 'LI', 'Europe/Vatican': 'VA', 'Europe/Vienna': 'AT',
  'Europe/Vilnius': 'LT', 'Europe/Volgograd': 'RU', 'Europe/Warsaw': 'PL', 'Europe/Zagreb': 'HR',
  'Europe/Zurich': 'CH', 'Indian/Antananarivo': 'MG', 'Indian/Chagos': 'IO', 'Indian/Christmas': 'CX',
  'Indian/Cocos': 'CC', 'Indian/Comoro': 'KM', 'Indian/Kerguelen': 'TF', 'Indian/Mahe': 'SC', 'Indian/Maldives': 'MV',
  'Indian/Mauritius': 'MU', 'Indian/Mayotte': 'YT', 'Indian/Reunion': 'RE', 'Pacific/Apia': 'WS',
  'Pacific/Auckland': 'NZ', 'Pacific/Bougainville': 'PG', 'Pacific/Chatham': 'NZ', 'Pacific/Easter': 'CL',
  'Pacific/Efate': 'VU', 'Pacific/Enderbury': 'KI', 'Pacific/Fakaofo': 'TK', 'Pacific/Fiji': 'FJ',
  'Pacific/Funafuti': 'TV', 'Pacific/Galapagos': 'EC', 'Pacific/Gambier': 'PF', 'Pacific/Guadalcanal': 'SB',
  'Pacific/Guam': 'GU', 'Pacific/Honolulu': 'US', 'Pacific/Kiritimati': 'KI', 'Pacific/Kosrae': 'FM',
  'Pacific/Kwajalein': 'MH', 'Pacific/Majuro': 'MH', 'Pacific/Marquesas': 'PF', 'Pacific/Midway': 'UM',
  'Pacific/Nauru': 'NR', 'Pacific/Niue': 'NU', 'Pacific/Norfolk': 'NF', 'Pacific/Noumea': 'NC',
  'Pacific/Pago_Pago': 'AS', 'Pacific/Palau': 'PW', 'Pacific/Pitcairn': 'PN', 'Pacific/Ponape': 'FM',
  'Pacific/Port_Moresby': 'PG', 'Pacific/Rarotonga': 'CK', 'Pacific/Saipan': 'MP', 'Pacific/Tahiti': 'PF',
  'Pacific/Tarawa': 'KI', 'Pacific/Tongatapu': 'TO', 'Pacific/Truk': 'FM', 'Pacific/Wake': 'UM', 'Pacific/Wallis': 'WF'
}

// Takes an IANA or a Windows name; Outlook reports both. Also another id of a listed zone (Asia/Kolkata, Europe/Kyiv).
export function windowsZone(zone: string): string | undefined {
  if (ianaZone(zone)) return zone
  const find = (iana?: string): string | undefined => (iana ? Object.keys(ZONES).find((name) => ZONES[name].includes(iana)) : undefined)
  return find(zone) ?? find(canonicalZone(zone))
}

export function ianaZone(windows: string): string | undefined {
  return ZONES[windows]?.[0]
}

// V8's own id of a zone: Asia/Kolkata gives Asia/Calcutta, Etc/UTC gives UTC. undefined: Intl does not know it
// (tzone://Microsoft/Custom, a Windows name).
export function canonicalZone(zone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

// The zones the zone picker lists, and this PC's zone, which the list may lack (Etc/GMT+11), as the dialogs offer it.
// Intl also takes '+01:00', 'europe/rome' or 'EST', so main takes only these.
export function isZone(zone: unknown): zone is string {
  return (
    typeof zone === 'string' &&
    (zone === 'UTC' || zone === Intl.DateTimeFormat().resolvedOptions().timeZone || Intl.supportedValuesOf('timeZone').includes(zone))
  )
}

// Minutes the zone is ahead of UTC at that moment.
export function zoneOffset(ms: number, zone: string): number {
  // sv-SE prints "2026-10-27 09:00:00": the wall time, read here as if it were UTC.
  const wall = Date.parse(new Date(ms).toLocaleString('sv-SE', { timeZone: zone }).replace(' ', 'T') + 'Z')
  return Math.round((wall - ms) / 60_000)
}

// The wall time in the zone as YYYY-MM-DD and HH:MM, the forms the date and time inputs use.
export function wallTime(ms: number, zone: string): { date: string; time: string } {
  const [date, time] = new Date(ms).toLocaleString('sv-SE', { timeZone: zone }).split(' ')
  return { date, time: time.slice(0, 5) }
}

// The moment of a wall time in the zone. It tries the offsets 12 h before and after: in the hour that repeats it takes
// the first, and a time in the DST gap moves forward. That is what new Date(y, m, d, h, min) does in this PC's zone.
export function zonedTime(date: string, time: string, zone: string): number {
  const wall = Date.parse(`${date}T${time}Z`)
  const tries = [-12, 12].map((h) => wall - zoneOffset(wall + h * 3600_000, zone) * 60_000)
  const same = (t: number): boolean => {
    const w = wallTime(t, zone)
    return w.date === date && w.time === time
  }
  return tries.find(same) ?? tries[0]
}
