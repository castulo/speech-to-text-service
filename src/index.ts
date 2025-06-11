import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import { SpeechClient } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import fs from 'fs';

const app = express();
app.use(cors());
const PORT = process.env.PORT ?? 3001;

// Configures Multer to save uploaded files to a local uploads/ folder.
const upload = multer({ dest: 'uploads/' });

const speechClient = new SpeechClient();
const storage = new Storage();

app.post('/transcribe', upload.single('audio'), async (req: Request, res: Response): Promise<void> => {
  const filePath = req.file?.path;
  const originalName = req.file?.originalname;

  if (!filePath || !originalName) {
    console.warn('No audio file uploaded or file path is missing');
    res.status(400).send('No audio file uploaded');

    return;
  }

  const bucketName = process.env.GCP_BUCKET_NAME!;
  const gcsUri = `gs://${bucketName}/${originalName}`;

  try {
    // the .recognize() method from the Google Speech-to-Text API only supports
    // transcribing files that are hosted remotely, so we need to upload the file
    // to Google Cloud Storage first
    await storage.bucket(bucketName).upload(filePath, {
      destination: originalName
    });

    // now we can transcribe the file using the Google Speech-to-Text API
    const [response] = await speechClient.recognize({
      audio: { uri: gcsUri },
      config: {
        encoding: 'LINEAR16', // .wav files are typically LINEAR16
        // sampleRateHertz: 16000,
        enableAutomaticPunctuation: true,
        languageCode: 'en-US'
      }
    });

    // For each transcription result:
	  // - result.alternatives is an array of possible transcription alternatives (Google often returns multiple guesses ranked by confidence)
    // - the code takes the first alternative [0], which is the most confident guess
    // - it then extracts the transcript text from that alternative
    // - finally, it joins all the transcripts into a single string with newlines separating them
    const transcription = response.results?.map(result => result.alternatives?.[0].transcript).join('\n');

    // delete the local file
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting file:', err);
    });

    // delete the file from Google Cloud Storage
    await storage.bucket(bucketName).file(originalName).delete();

    console.log(`\nTranscription for ${originalName}:\n${transcription}\n`);
    res.json({ text: transcription });
  } catch (error) {
    console.error(`There was an error transcribing the audio file: ${error}`);

    res.status(500).send('Transcription failed.');
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
