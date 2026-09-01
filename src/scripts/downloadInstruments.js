import fs from 'fs';
import https from 'https';

const url = 'https://api.kite.trade/instruments';

const filePath = './instruments.csv';

console.log('Downloading Zerodha instruments...');

https.get(url, (res) => {

    const fileStream = fs.createWriteStream(filePath);

    res.pipe(fileStream);

    fileStream.on('finish', () => {
        fileStream.close();
        console.log('Download completed:', filePath);
    });

}).on('error', (err) => {
    console.error('Download failed:', err.message);
});