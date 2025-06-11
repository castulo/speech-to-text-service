import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import { SpeechClient } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import textToSpeech, { protos } from '@google-cloud/text-to-speech';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT ?? 3001;

// Configures Multer to save uploaded files to a local uploads/ folder.
const upload = multer({ dest: 'uploads/' });

const speechClient = new SpeechClient();
const storage = new Storage();
const ttsClient = new textToSpeech.TextToSpeechClient();

async function convertM4aToWav(inputPath: string): Promise<{ wavPath: string; sampleRate: number }> {
  console.log(`Converting ${inputPath} to wav format...`);
  const parsed = path.parse(inputPath);
  const wavPath = path.join(parsed.dir, `${parsed.name}.wav`);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(wavPath);
  });

  return { wavPath, sampleRate: 16000 };
}

app.post('/transcribe', upload.single('audio'), async (req: Request, res: Response): Promise<void> => {
  const filePath = req.file?.path;
  const originalName = req.file?.originalname;

  if (!filePath || !originalName) {
    console.warn('No audio file uploaded or file path is missing');
    res.status(400).send('No audio file uploaded');

    return;
  }

  const bucketName = process.env.GCP_BUCKET_NAME!;
  const ext = path.extname(originalName).toLowerCase();

  // convert if needed
  let wavPath = filePath;
  let sampleRate = 16000;

  if (ext === '.m4a') {
    try {
      const result = await convertM4aToWav(filePath);
      wavPath = result.wavPath;
      sampleRate = result.sampleRate;
    } catch (error) {
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
      console.error(`There was an error converting the file: ${error}`);
      res.status(500).send('Could not convert m4a to wav');

      return;
    }
  }

  const gcsName = path.basename(wavPath);
  const gcsUri = `gs://${bucketName}/${gcsName}`;

  try {
    // the .recognize() method from the Google Speech-to-Text API only supports
    // transcribing files that are hosted remotely, so we need to upload the file
    // to Google Cloud Storage first
    await storage.bucket(bucketName).upload(wavPath, {
      destination: gcsName
    });

    // now we can transcribe the file using the Google Speech-to-Text API
    const [response] = await speechClient.recognize({
      audio: { uri: gcsUri },
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: sampleRate,
        enableAutomaticPunctuation: true,
        languageCode: 'en-US'
      }
    });

    // For each transcription result:
	  // - result.alternatives is an array of possible transcription alternatives (Google often returns multiple guesses ranked by confidence)
    // - the code takes the first alternative [0], which is the most confident guess
    // - it then extracts the transcript text from that alternative
    // - finally, it joins all the transcripts into a single string with newlines separating them
    const transcription = response.results?.map(result => result.alternatives?.[0]?.transcript ?? '').join('\n') ?? '';

    // delete the local files
    if (filePath !== wavPath) {
      fs.unlink(filePath, err => { if (err) console.error('Error deleting file:', err); });
    }
    fs.unlink(wavPath, err => { if (err) console.error('Error deleting file:', err); });

    // delete the file from Google Cloud Storage
    await storage.bucket(bucketName).file(gcsName).delete();

    console.log(`\nTranscription for ${originalName}:\n${transcription}\n`);
    res.json({ text: transcription });
  } catch (error) {
    console.error(`There was an error transcribing the audio file: ${error}`);

    res.status(500).send('Transcription failed.');
  }
});

app.post('/speak', async (req: Request, res: Response): Promise<void> => {
  const { text } = req.body;

  if (!text) {
    console.warn('No "text" provided in request body');
    res.status(400).json({ error: 'Missing "text" in request body' });

    return
  }

  console.log(`Received text to synthesize: "${text}"`);

  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: {
      languageCode: 'en-US',
      ssmlGender: protos.google.cloud.texttospeech.v1.SsmlVoiceGender.FEMALE,
    },
    audioConfig: {
      audioEncoding: protos.google.cloud.texttospeech.v1.AudioEncoding.MP3,
    },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);

    if (!response.audioContent) {
      res.status(500).json({ error: 'Failed to synthesize speech' });

      return
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'attachment; filename="speech.mp3"',
    });
    res.send(response.audioContent);
  } catch (error) {
    console.error('Text-to-Speech error:', error);
    res.status(500).json({ error: 'Text-to-Speech failed' });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
