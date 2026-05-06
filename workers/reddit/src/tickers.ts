// Curated universe of ~700 commonly-mentioned US tickers. The point isn't to
// cover every listed equity — it's to give the extractor enough recall on
// WSB-style chatter while keeping false positives (e.g. matching the word
// 'ALL' as a ticker) under control.
//
// Keep this list alphabetised so adding new symbols is a one-line diff.

export const TICKER_UNIVERSE: ReadonlySet<string> = new Set([
  // Major ETFs / index proxies
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'VEA', 'VWO', 'VXX', 'UVXY', 'SVXY',
  'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'SOXL', 'SOXS', 'TLT', 'TBT', 'GLD', 'SLV',
  'USO', 'UNG', 'XLE', 'XLF', 'XLK', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB',
  'XLRE', 'XLC', 'ARKK', 'ARKG', 'ARKW', 'JEPI', 'JEPQ', 'SCHD', 'VIG', 'VYM',
  'BITO', 'IBIT', 'FBTC', 'GBTC', 'ETHE', 'HYG', 'LQD', 'AGG', 'BND',

  // Mega caps
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'BRK.A',
  'BRK.B', 'JPM', 'V', 'MA', 'UNH', 'XOM', 'WMT', 'PG', 'JNJ', 'HD', 'CVX',
  'LLY', 'ABBV', 'MRK', 'KO', 'PEP', 'AVGO', 'COST', 'BAC', 'WFC', 'CRM',
  'ADBE', 'CSCO', 'TMO', 'ACN', 'MCD', 'ABT', 'NKE', 'DHR', 'TXN', 'NEE',
  'PM', 'LIN', 'UNP', 'AMD', 'ORCL', 'INTC', 'IBM', 'QCOM', 'INTU', 'AMAT',
  'NOW', 'GE', 'BA', 'CAT', 'MMM', 'GS', 'MS', 'C', 'BLK', 'AXP', 'SCHW',

  // WSB perennials & meme stocks
  'GME', 'AMC', 'BB', 'BBBY', 'NOK', 'PLTR', 'SOFI', 'HOOD', 'COIN', 'RBLX',
  'NIO', 'XPEV', 'LI', 'LCID', 'RIVN', 'RIDE', 'WKHS', 'NKLA', 'F', 'GM',
  'FORD', 'CHWY', 'WISH', 'CLOV', 'MULN', 'TLRY', 'CGC', 'CRON', 'ACB', 'SNDL',
  'DKNG', 'PENN', 'MGM', 'WYNN', 'LVS', 'DJT', 'TRUTH', 'PHUN', 'DWAC', 'VINE',
  'BYND', 'OATLY', 'PTON', 'ZM', 'DOCU', 'FUBO', 'GOEV', 'MARA', 'RIOT', 'HUT',
  'BITF', 'CLSK', 'CIFR', 'IREN', 'WULF', 'CAN', 'EBON', 'ARBK',

  // High beta tech / growth
  'SNOW', 'NET', 'DDOG', 'CRWD', 'ZS', 'OKTA', 'PANW', 'FTNT', 'CYBR', 'S',
  'ESTC', 'MDB', 'TEAM', 'ATLR', 'SHOP', 'SQ', 'PYPL', 'AFRM', 'UPST', 'LMND',
  'PINS', 'SNAP', 'TWLO', 'BAND', 'ZI', 'BILL', 'CFLT', 'PATH', 'AI', 'BBAI',
  'SOUN', 'IONQ', 'RGTI', 'QBTS', 'ARM', 'SMCI', 'DELL', 'HPE', 'HPQ', 'NTAP',
  'PSTG', 'WDC', 'STX', 'ANET', 'JNPR', 'CIEN', 'LITE', 'IIVI', 'MRVL', 'ON',
  'MU', 'ASML', 'TSM', 'AMKR', 'KLAC', 'LRCX', 'ADI', 'MCHP', 'NXPI', 'STM',

  // Biotech / pharma
  'PFE', 'BMY', 'GILD', 'AMGN', 'BIIB', 'REGN', 'VRTX', 'MRNA', 'BNTX', 'NVAX',
  'OCGN', 'INO', 'CRSP', 'EDIT', 'NTLA', 'BEAM', 'VERV', 'SAVA', 'AXSM', 'IOVA',
  'SRPT', 'BLUE', 'SGMO', 'GLPG', 'ALNY', 'IONS', 'EXEL', 'INCY', 'TECH',
  'NVO', 'AZN', 'GSK', 'SNY', 'TAK',

  // Financials / insurance / fintech
  'BX', 'KKR', 'APO', 'ARES', 'CG', 'OWL', 'TROW', 'BEN', 'AMG', 'IVZ', 'SEIC',
  'STT', 'BK', 'NTRS', 'USB', 'PNC', 'TFC', 'COF', 'DFS', 'SYF', 'ALLY', 'CFG',
  'AIG', 'PRU', 'MET', 'AFL', 'TRV', 'ALL', 'PGR', 'CB', 'HIG', 'MKL',

  // Energy / commodities
  'COP', 'EOG', 'OXY', 'PXD', 'VLO', 'PSX', 'MPC', 'HES', 'DVN', 'FANG', 'APA',
  'MRO', 'CTRA', 'OVV', 'RRC', 'CHK', 'AR', 'EQT', 'BP', 'SHEL', 'TTE', 'E',
  'EQNR', 'BTU', 'CEIX', 'ARCH', 'METC', 'HCC', 'AA', 'X', 'CLF', 'NUE', 'STLD',
  'FCX', 'SCCO', 'TECK', 'BHP', 'RIO', 'VALE', 'NEM', 'GOLD', 'AEM', 'KGC',

  // Consumer / retail / travel
  'TGT', 'LOW', 'TJX', 'ROST', 'BURL', 'DG', 'DLTR', 'BBY', 'KSS', 'M',
  'JWN', 'GPS', 'ANF', 'AEO', 'URBN', 'LULU', 'CROX', 'DECK', 'SKX', 'UA',
  'UAA', 'VFC', 'TPR', 'CPRI', 'RL', 'PVH', 'HBI', 'GIL', 'YETI', 'WHR',
  'SBUX', 'CMG', 'YUM', 'QSR', 'WEN', 'JACK', 'WING', 'SHAK', 'CAVA', 'DASH',
  'UBER', 'LYFT', 'ABNB', 'BKNG', 'EXPE', 'TRIP', 'MAR', 'HLT', 'H', 'IHG',
  'CCL', 'NCLH', 'RCL', 'AAL', 'DAL', 'UAL', 'LUV', 'ALK', 'JBLU', 'SAVE',
  'BA', 'LMT', 'RTX', 'NOC', 'GD', 'HII', 'LHX', 'TDG', 'HEI', 'TXT',

  // Media / comms / streaming
  'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'PARA', 'WBD', 'FOX',
  'FOXA', 'NWSA', 'NYT', 'IPG', 'OMC', 'WPP', 'TTD', 'ROKU', 'SPOT', 'WMG',
  'MTCH', 'BMBL', 'YELP', 'TRIP', 'IAC', 'Z', 'ZG', 'RDFN', 'OPEN', 'ANGI',

  // Industrials / autos / EV
  'DE', 'AGCO', 'CNHI', 'CAT', 'TEX', 'OSK', 'PCAR', 'CMI', 'WAB', 'EMR',
  'ETN', 'PH', 'ITW', 'ROK', 'IR', 'XYL', 'DOV', 'FTV', 'AME', 'GNRC',
  'TT', 'CARR', 'OTIS', 'JCI', 'WM', 'RSG', 'WCN', 'CWST', 'SRCL',
  'STLA', 'TM', 'HMC', 'VWAGY', 'BMWYY', 'MBGYY', 'POAHY', 'PSNY', 'FSR',
  'WKHS', 'GOEV', 'ARVL', 'HYZN', 'PLUG', 'BLDP', 'BE', 'FCEL', 'BLNK',
  'EVGO', 'CHPT', 'WBX', 'QS', 'STEM', 'ENPH', 'SEDG', 'RUN', 'NOVA', 'FSLR',

  // China ADRs (heavy WSB chatter)
  'BABA', 'JD', 'PDD', 'BIDU', 'NTES', 'TCEHY', 'BILI', 'IQ', 'YMM', 'TAL',
  'EDU', 'BEKE', 'TIGR', 'FUTU', 'ZH', 'DIDI', 'DOYU', 'HUYA', 'WB', 'SINA',

  // Misc heavy-mention
  'WBA', 'CVS', 'CI', 'HUM', 'CNC', 'MOH', 'ELV', 'UNH', 'HCA', 'THC', 'UHS',
  'DVA', 'TDOC', 'HIMS', 'GDRX', 'OSCR', 'CLOV', 'ALHC',
  'BABA', 'BIDU', 'NIO', 'LI', 'XPEV', 'TIGR', 'FUTU', 'YMM',
  'UPS', 'FDX', 'CHRW', 'EXPD', 'XPO', 'JBHT', 'ODFL', 'KNX', 'WERN', 'SAIA',
  'CSX', 'NSC', 'UNP', 'CP', 'CNI',
]);

// Words that look like tickers but are noise on WSB. The regex extractor
// finds 1-5 letter uppercase tokens; this list rejects the ones that are
// almost always English / WSB jargon, never a stock reference.
export const TICKER_DENYLIST: ReadonlySet<string> = new Set([
  // English short words
  'A', 'I', 'AM', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN',
  'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE',
  'AND', 'ARE', 'BUT', 'FOR', 'NOT', 'THE', 'YOU', 'ALL', 'ANY', 'CAN', 'HAD',
  'HAS', 'HER', 'HIS', 'HOW', 'ITS', 'OUR', 'OUT', 'SHE', 'TWO', 'WAS', 'WHO',
  'WHY', 'YES', 'NEW', 'OLD', 'GET', 'GOT', 'PUT', 'BIG', 'TOP', 'LOW', 'OFF',
  'WIN', 'LOSE', 'NOW', 'HERE', 'THIS', 'THAT', 'WITH', 'FROM', 'WHAT', 'WHEN',
  'JUST', 'LIKE', 'SOME', 'WILL', 'YOUR', 'BEEN', 'HAVE', 'INTO', 'OVER', 'ONLY',
  'THEY', 'THEM', 'THEIR', 'THERE', 'WHICH', 'WOULD', 'COULD', 'SHOULD', 'GONNA',
  'WANNA', 'OKAY', 'EVEN', 'STILL', 'EVER', 'NEVER', 'TRUE', 'FALSE', 'MORE',
  'LESS', 'THAN', 'BACK', 'GOOD', 'BAD', 'SURE', 'LONG', 'SHORT', 'NEXT', 'LAST',
  'YEAR', 'WEEK', 'DAY', 'TIME', 'WORK', 'HELP', 'LOVE', 'HATE', 'MAKE', 'TAKE',
  'GIVE', 'CALL', 'CALLS', 'PUTS', 'EARN', 'BUY', 'SELL', 'HOLD', 'BAG', 'BAGS',
  // WSB jargon / abbreviations
  'WSB', 'YOLO', 'DD', 'FD', 'FDS', 'TLDR', 'TLDR;', 'HODL', 'BTFD', 'IPO',
  'CEO', 'CFO', 'COO', 'CTO', 'IPO', 'SEC', 'FED', 'FOMC', 'CPI', 'PPI', 'PMI',
  'GDP', 'NFP', 'EPS', 'PE', 'PEG', 'EBITDA', 'OTM', 'ITM', 'ATM', 'EOD', 'EOW',
  'EOM', 'EOY', 'AH', 'PM', 'AM', 'EST', 'ET', 'PT', 'PST', 'UTC', 'GMT', 'USD',
  'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'CAD', 'AUD', 'NZD', 'CHF', 'INR', 'IRS',
  'IRA', 'ROTH', 'ETF', 'NYSE', 'NASDAQ', 'AMEX', 'OTC', 'ER', 'GUH', 'LFG',
  'NGL', 'IMO', 'IMHO', 'IIRC', 'AFAIK', 'TIL', 'TIA', 'OP', 'PSA', 'NSFW',
  'NSFL', 'GG', 'WP', 'GL', 'HF', 'EZ', 'SMH', 'LMAO', 'LOL', 'WTF', 'OMG',
  'AF', 'BS', 'BTW', 'IDK', 'IDC', 'TBH', 'TYSM', 'NGMI', 'WAGMI', 'RIP', 'GZ',
  'USA', 'UK', 'EU', 'UN', 'NATO', 'CCP', 'CIA', 'FBI', 'NSA', 'IRS', 'SBA',
  'API', 'CEO', 'AI', 'ML', 'AGI', 'LLM', 'GPU', 'CPU', 'RAM', 'SSD', 'HDD',
  'TV', 'PC', 'OS', 'DEX', 'CEX', 'NFT', 'POS', 'POW', 'KYC', 'AML', 'TOS',
  'PT', 'SL', 'TP', 'OB', 'FOMO', 'FUD', 'ATH', 'ATL', 'BTD', 'BTFD',
]);
