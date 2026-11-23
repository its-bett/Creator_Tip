import { ProfileFromParams } from "@/components/profile";

export default function CreatorProfilePage({
  params,
}: PageProps<"/[username]">) {
  return <ProfileFromParams params={params} />;
}
