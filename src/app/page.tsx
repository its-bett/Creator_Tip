import { Profile } from "@/components/profile";
import { DEFAULT_CREATOR_USERNAME } from "@/lib/seed";

export default function Home() {
  return <Profile username={DEFAULT_CREATOR_USERNAME} />;
}
