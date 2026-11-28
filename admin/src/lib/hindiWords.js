// Dish names are usually typed in English letters, and a Hindi voice says them properly only when they are written in Hindi.
// So the common words of a cafe or restaurant menu are listed here. A word that is not listed is left as it was typed.

const WORDS = new Map(
  Object.entries({
    // drinks
    chai: 'चाय', tea: 'टी', coffee: 'कॉफ़ी', cappuccino: 'कैपुचीनो', espresso: 'एस्प्रेसो', latte: 'लाते', mocha: 'मोका', filter: 'फ़िल्टर',
    cutting: 'कटिंग', adrak: 'अदरक', ginger: 'जिंजर', elaichi: 'इलायची', kesar: 'केसर', chocolate: 'चॉकलेट', milk: 'मिल्क', shake: 'शेक', milkshake: 'मिल्कशेक',
    lassi: 'लस्सी', chaas: 'छाछ', soda: 'सोडा', lime: 'लाइम', lemon: 'लेमन', nimbu: 'नींबू', pani: 'पानी', juice: 'जूस', water: 'वॉटर', bottle: 'बॉटल', mineral: 'मिनरल',
    mango: 'मैंगो', orange: 'ऑरेंज', apple: 'एप्पल', pineapple: 'पाइनएप्पल', banana: 'बनाना', strawberry: 'स्ट्रॉबेरी', vanilla: 'वनीला', oreo: 'ओरियो', mojito: 'मोहीतो', cola: 'कोला',
    // snacks and meals
    bun: 'बन', maska: 'मस्का', samosa: 'समोसा', vada: 'वड़ा', pav: 'पाव', bhaji: 'भाजी', khari: 'खारी', biscuit: 'बिस्किट', maggi: 'मैगी', sandwich: 'सैंडविच', toast: 'टोस्ट',
    pakora: 'पकौड़ा', plate: 'प्लेट', pizza: 'पिज़्ज़ा', margherita: 'मार्गेरिटा', pepperoni: 'पेपरोनी', burger: 'बर्गर', fries: 'फ्राइज़', french: 'फ्रेंच', pasta: 'पास्ता', roll: 'रोल',
    momos: 'मोमोज़', noodles: 'नूडल्स', hakka: 'हक्का', manchurian: 'मंचूरियन', soup: 'सूप', salad: 'सलाद', corn: 'कॉर्न', kabab: 'कबाब', kebab: 'कबाब', tikka: 'टिक्का',
    paneer: 'पनीर', aloo: 'आलू', gobi: 'गोभी', matar: 'मटर', mutter: 'मटर', palak: 'पालक', kofta: 'कोफ़्ता', korma: 'कोरमा', kadai: 'कढ़ाई', makhani: 'मखनी', shahi: 'शाही', malai: 'मलाई',
    hara: 'हरा', bhara: 'भरा', dal: 'दाल', tadka: 'तड़का', jeera: 'जीरा', rice: 'राइस', biryani: 'बिरयानी', pulao: 'पुलाव', khichdi: 'खिचड़ी', kadhi: 'कढ़ी', thali: 'थाली',
    roti: 'रोटी', naan: 'नान', paratha: 'पराठा', puri: 'पूरी', kulcha: 'कुलचा', chole: 'छोले', bhature: 'भटूरे', dosa: 'डोसा', idli: 'इडली', uttapam: 'उत्तपम', sambar: 'सांभर',
    poha: 'पोहा', upma: 'उपमा', dhokla: 'ढोकला', khaman: 'खमण', thepla: 'थेपला', fafda: 'फाफड़ा', sev: 'सेव', bhel: 'भेल', chaat: 'चाट', dahi: 'दही',
    // sweets
    gulab: 'गुलाब', jamun: 'जामुन', brownie: 'ब्राउनी', ice: 'आइस', cream: 'क्रीम', kulfi: 'कुल्फ़ी', jalebi: 'जलेबी', rasgulla: 'रसगुल्ला', halwa: 'हलवा', kheer: 'खीर',
    // describing words
    veg: 'वेज', masala: 'मसाला', butter: 'बटर', cheese: 'चीज़', garlic: 'गार्लिक', bread: 'ब्रेड', chilli: 'चिली', chilly: 'चिली', mint: 'मिंट', tomato: 'टोमैटो', gravy: 'ग्रेवी',
    fried: 'फ्राइड', grilled: 'ग्रिल्ड', crispy: 'क्रिस्पी', spring: 'स्प्रिंग', dry: 'ड्राई', spicy: 'स्पाइसी', sweet: 'स्वीट', salted: 'सॉल्टेड', plain: 'प्लेन', mix: 'मिक्स',
    hot: 'हॉट', cold: 'कोल्ड', iced: 'आइस्ड', fresh: 'फ्रेश', green: 'ग्रीन', black: 'ब्लैक', white: 'व्हाइट', special: 'स्पेशल', extra: 'एक्स्ट्रा', double: 'डबल', single: 'सिंगल',
    half: 'हाफ़', full: 'फुल', regular: 'रेगुलर', small: 'स्मॉल', medium: 'मीडियम', large: 'लार्ज', jain: 'जैन', gujarati: 'गुजराती', punjabi: 'पंजाबी', chinese: 'चाइनीज़',
    south: 'साउथ', indian: 'इंडियन', with: 'विद', and: 'एंड', pcs: 'पीस', pc: 'पीस', piece: 'पीस', pieces: 'पीस',
  }),
);

/** "Brownie with Ice Cream" -> "ब्राउनी विद आइसक्रीम", "Samosa (2 pcs)" -> "समोसा 2 पीस". */
export const dishInHindi = (name) =>
  String(name)
    .replace(/\bice[\s-]*cream\b/gi, 'आइसक्रीम')
    .replace(/&/g, ' और ')
    .replace(/[()[\]{}/|_-]+/g, ' ')
    .replace(/[A-Za-z]+/g, (word) => WORDS.get(word.toLowerCase()) ?? word)
    .replace(/\s+/g, ' ')
    .trim();
